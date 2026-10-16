import { createHash } from 'node:crypto';
import { QueryResponseSchema } from '@tslightrag/contracts';
import type { QueryResponse, StreamEvent } from '@tslightrag/contracts';
import type { QueryService } from '../retrieval/service.js';
import type { ModelClient } from '../models/client.js';
import { ModelError } from '../models/errors.js';
import { BoundedCache } from './cache.js';

export function citationWarnings(answer:string,allowed:readonly string[]) {
  const valid=new Set(allowed),unknown=new Set<string>();
  for(const match of answer.matchAll(/\[((?:\d+|DC\d+)(?:\s*[,，]\s*(?:\d+|DC\d+))*)\]/gi))for(const id of match[1]!.split(/\s*[,，]\s*/))if(!valid.has(id)&&unknown.size<20)unknown.add(id);
  return unknown.size?[`回答包含不存在的引用 ID：${[...unknown].join('、')}；未创建或补造来源`]:[];
}
export function textParts(text:string){
  const out:string[]=[];
  for(let i=0;i<text.length;){let end=Math.min(i+16000,text.length);const last=text.charCodeAt(end-1);if(end<text.length&&last>=0xd800&&last<=0xdbff)end--;out.push(text.slice(i,end));i=end;}
  return out;
}
export class GenerationService {
  private readonly answers=new BoundedCache(QueryResponseSchema,{entries:64,bytes:16*1024*1024,ttlMs:15*60_000});
  private scope='';
  private readonly completing=new Map<string,Promise<void>>();
  constructor(private readonly queries:QueryService,private readonly models:ModelClient){}
  async answer(input:unknown,options:{requestId:string;signal?:AbortSignal;emit?:(event:StreamEvent)=>Promise<void>;deliver?:(result:QueryResponse)=>Promise<void>}) {
    let terminal=false;
    const emit=async(event:StreamEvent)=>{if(!terminal)await options.emit?.(event);};
    const finish=async(event:Extract<StreamEvent,{type:'done'|'error'|'cancelled'}>)=>{if(terminal)return;terminal=true;await options.emit?.(event);};
    const check=()=>{if(options.signal?.aborted)throw new ModelError('MODEL_CANCELLED','查询已取消',499);};
    try{
      return await this.queries.withSession(input,options.signal,async session=>{
        const {query,view,config,embedding}=session;
        const scope=JSON.stringify([view.corpusRevision,config.revision,view.indexBinding?.spaceId??null]);
        if(this.scope!==scope){this.answers.clear();this.scope=scope;}
        const key=createHash('sha256').update(JSON.stringify(['s09-answer-rag-aaebfe1-v1',scope,config,embedding,query])).digest('hex');
        const waiting=this.completing.get(key);
        if(waiting){
          let abort:(()=>void)|undefined;
          try{await Promise.race([waiting,new Promise<never>((_resolve,reject)=>{abort=()=>reject(new ModelError('MODEL_CANCELLED','查询已取消',499));if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});})]);}
          finally{if(abort)options.signal?.removeEventListener('abort',abort);}
        }
        check();
        const debug=query.onlyNeedContext||query.onlyNeedPrompt;
        const cached=debug?undefined:this.answers.get(key);
        await emit({type:'meta',requestId:options.requestId,mode:query.mode,cached:Boolean(cached)});check();
        if(cached){
          const result=QueryResponseSchema.parse({...cached,cached:true});
          await emit({type:'references',references:result.references});
          for(const text of textParts(result.answer)){check();await emit({type:'delta',text});}
          check();await options.deliver?.(result);
          await finish({type:'done',finishReason:result.finishReason,warnings:result.warnings,cached:true,status:result.status,data:result.data});return result;
        }
        const {data,messages}=await this.queries.prepare(session,options.signal);check();
        await emit({type:'references',references:data.references});
        const warnings=[...data.warnings];let answer:string,finishReason:'stop'|'length'='stop';
        const delta=async(text:string)=>{for(const part of textParts(text)){check();await emit({type:'delta',text:part});}};
        if(debug){answer=data.content;await delta(answer);}
        else if(data.status==='empty'){answer='未找到与问题相关的知识库证据。';await delta(answer);}
        else{
          if(!data.references.length)warnings.push('仅有图谱描述，当前没有可引用的文本块');
          const generated=await this.models.chat(session.text,messages,{...(options.signal?{signal:options.signal}:{}),...(options.emit?{onDelta:delta}:{})});
          answer=generated.text;finishReason=generated.finishReason;
          warnings.push(...citationWarnings(answer,data.references.map(r=>r.id)));
          if(finishReason==='length')warnings.push('回答达到模型输出上限，内容可能不完整，未写入回答缓存');
        }
        check();
        const result=QueryResponseSchema.parse({answer,mode:query.mode,status:debug?'preview':data.status,finishReason,references:data.references,warnings,cached:false,data});
        // Waiters arriving at response EOF must see the completion decision, not race its microtask.
        let release!:()=>void;const completion=new Promise<void>(resolve=>{release=resolve;});
        if(!this.completing.has(key))this.completing.set(key,completion);
        try{
          // A complete delivery wins the terminal race; a close before this point never publishes cache.
          await options.deliver?.(result);check();
          await finish({type:'done',finishReason,warnings,cached:false,status:result.status,data});
          if(!debug&&result.status==='success'&&finishReason==='stop'&&!warnings.length&&!options.signal?.aborted&&this.queries.current(session)&&this.scope===scope){
            if(Buffer.byteLength(JSON.stringify(result))<=1024*1024)this.answers.set(key,result);
          }
        }finally{if(this.completing.get(key)===completion)this.completing.delete(key);release();}
        return result;
      });
    }catch(error){
      const cancelled=options.signal?.aborted||(error instanceof ModelError&&error.code==='MODEL_CANCELLED');
      if(options.emit){
        if(!terminal){try{await finish(cancelled?{type:'cancelled'}:{type:'error',error:{code:error instanceof ModelError?error.code:'INTERNAL_ERROR',message:error instanceof ModelError?error.message:'回答生成失败',requestId:options.requestId}});}catch{/* Disconnected clients cannot receive a terminal line. */}}
        return undefined;
      }
      if(cancelled)throw new ModelError('MODEL_CANCELLED','查询已取消',499);
      throw error;
    }
  }
}
