import { createHash } from 'node:crypto';
import { z } from 'zod';
import { QuerySchema, QueryDataSchema, ChunkSchema } from '@tslightrag/contracts';
import type { Query, QueryData } from '@tslightrag/contracts';
import type { GraphNode, GraphEdge } from '../storage/graph.js';
import type { ModelConfigStore, ModelConfig, PrivateProfile } from '../models/config.js';
import { boundProfile, embeddingSpaceId } from '../models/config.js';
import type { ModelClient } from '../models/client.js';
import type { SnapshotStore, SnapshotView } from '../storage/snapshot.js';
import { ModelError } from '../models/errors.js';
import { prompts, render } from '../indexing/prompts.js';
import { countTokens } from '../core/tokenizer.js';
import { roundRobin, localRelations, globalEntities, selectSources } from './algorithms.js';
import { buildContext, entityRecord, relationRecord, contextJson, prefixBudget } from './context.js';
import type { QueryChunk } from './context.js';
import { BoundedCache } from '../generation/cache.js';
import { retrievalPrompts } from './prompts.js';

export function normalizeKeywords(value:unknown):string[]{
  const rows=typeof value==='string'?value.split(/[\n,;]+/):Array.isArray(value)?value:[];
  return rows.filter((s):s is string=>typeof s==='string').map(s=>s.trim()).filter(Boolean);
}
const Keywords=z.object({high_level_keywords:z.unknown(),low_level_keywords:z.unknown()});
export type QuerySession = {query:Query;view:SnapshotView;config:ModelConfig;embedding:Extract<PrivateProfile,{kind:'embedding'}>;text:Extract<PrivateProfile,{kind:'text'}>};
const KeywordCacheSchema=z.strictObject({high:z.array(z.string().min(1).max(500)).max(100),low:z.array(z.string().min(1).max(500)).max(100)});
const EmbeddingCacheSchema=z.strictObject({spaceId:z.string(),dimensions:z.number().int().positive(),vectors:z.array(z.array(z.number().finite()).min(1).max(65536)).min(1).max(3)}).refine(v=>v.vectors.every(row=>row.length===v.dimensions&&Math.hypot(...row)>0));
export class QueryService {
  private readonly cache=new BoundedCache(KeywordCacheSchema,{entries:256,bytes:8*1024*1024,ttlMs:15*60_000});
  private readonly embeddings=new BoundedCache(EmbeddingCacheSchema,{entries:256,bytes:8*1024*1024,ttlMs:15*60_000});
  private active=0;
  constructor(private readonly storage:SnapshotStore,private readonly config:ModelConfigStore,private readonly models:ModelClient){}
  async data(input:unknown,signal?:AbortSignal):Promise<QueryData>{return this.withSession(input,signal,async session=>(await this.prepare(session,signal)).data);}
  async withSession<T>(input:unknown,signal:AbortSignal|undefined,work:(session:QuerySession)=>Promise<T>):Promise<T>{
    const parsed=QuerySchema.safeParse(input);if(!parsed.success)throw new ModelError('INVALID_QUERY','查询参数不合法',400);
    if(this.active>=4)throw new ModelError('QUERY_BUSY','检索通道已满，请稍后重试',429);
    this.active++;
    try{
      if(signal?.aborted)throw new ModelError('MODEL_CANCELLED','查询已取消',499);
      const {view,profile:embedding}=this.config.captureIndex(),config=this.config.capture(),text=boundProfile(config,'query');
      if(text?.kind!=='text'||embedding?.kind!=='embedding')throw new ModelError('MODEL_NOT_CONFIGURED','请配置文本和向量模型',409);
      return await work({query:parsed.data,view,embedding,config,text});
    }finally{this.active--;}
  }
  current(session:QuerySession){return this.storage.healthy&&this.storage.capture().corpusRevision===session.view.corpusRevision&&this.config.capture().revision===session.config.revision;}
  async prepare(session:QuerySession,signal?:AbortSignal){
    const {query,view,embedding,config,text}=session,keyword=boundProfile(config,'keyword');
    const spaceId=embeddingSpaceId(embedding)!;
    const warnings:string[]=[];const branches:QueryData['diagnostics']['branches']=[];
    let keywords={high:[] as string[],low:[] as string[],cached:false};
    // Validate fixed request overhead before issuing any model calls.
    buildContext(view,query,text,[],[],[]);
    let noResult=false;
    if(query.mode!=='naive'){
      if(keyword?.kind!=='text')throw new ModelError('MODEL_NOT_CONFIGURED','请配置关键词模型',409);
      const prompt=render(prompts.keywords_extraction,{query:query.query,language:'Chinese',examples:retrievalPrompts.keywords_extraction_examples.join('\n')});
      const key=createHash('sha256').update(JSON.stringify(['s08-keywords-aaebfe1',config.revision,keyword,query.query,'Chinese'])).digest('hex');
      const cached=this.cache.get(key);
      if(cached)keywords={...structuredClone(cached),cached:true};
      else{
        if(countTokens(prompt,keyword.tokenizer)+keyword.maxOutputTokens+16>keyword.contextTokens)throw new ModelError('QUERY_BUDGET_EXCEEDED','关键词提示超过模型上下文',400);
        const result=await this.models.chat(keyword,[{role:'user',content:prompt}],signal?{signal}:{});
        if(result.finishReason==='length')throw new ModelError('KEYWORDS_TRUNCATED','关键词响应被截断',502);
        let payload:unknown;try{payload=JSON.parse(result.text);}catch{throw new ModelError('KEYWORDS_INVALID','关键词模型未返回有效 JSON',502);}
        const parsed=Keywords.safeParse(payload);if(!parsed.success)throw new ModelError('KEYWORDS_INVALID','关键词 JSON 缺少高层或低层字段',502);
        keywords={high:normalizeKeywords(parsed.data.high_level_keywords),low:normalizeKeywords(parsed.data.low_level_keywords),cached:false};
        if(keywords.high.length+keywords.low.length>100||[...keywords.high,...keywords.low].some(k=>k.length>500))throw new ModelError('KEYWORDS_INVALID','关键词响应超过限制',502);
        if(!signal?.aborted&&(keywords.high.length||keywords.low.length))this.cache.set(key,{high:keywords.high,low:keywords.low});
      }
      if(!keywords.low.length&&!keywords.high.length){if([...query.query].length<50){keywords.low=[query.query];warnings.push('关键词为空，使用短查询作为低层关键词');}else noResult=true;}
    }
    let local:GraphNode[]=[],global:GraphEdge[]=[],localEdges:GraphEdge[]=[],globalNodes:GraphNode[]=[];let direct:QueryChunk[]=[];
    const chunk=(id:string,source:QueryChunk['source']):QueryChunk[]=>{const parsed=ChunkSchema.safeParse(view.getKV('textChunks',id));return parsed.success?[{...parsed.data,source,referenceId:''}]:[];};
    let queryVector:number[]|undefined;let embeddingsCached=false;
    if(!noResult&&view.size('textChunks')){
      // Match upstream missing-keyword cross-mode fallback; hybrid/mix run whichever side exists.
      let needLow=['local','hybrid','mix'].includes(query.mode)&&keywords.low.length>0;
      let needHigh=['global','hybrid','mix'].includes(query.mode)&&keywords.high.length>0;
      if(query.mode==='local'&&!needLow)needHigh=keywords.high.length>0;
      if(query.mode==='global'&&!needHigh)needLow=keywords.low.length>0;
      const inputs:string[]=[];
      const original=query.mode==='naive'||query.mode==='mix'||query.kgChunkPickMethod==='VECTOR';
      if(original)inputs.push(query.query);if(needLow)inputs.push(keywords.low.join(', '));if(needHigh)inputs.push(keywords.high.join(', '));
      const embeddingKey=createHash('sha256').update(JSON.stringify(['s09-query-embeddings-v1',embedding,spaceId,inputs])).digest('hex');
      const hit=this.embeddings.get(embeddingKey);embeddingsCached=Boolean(hit);
      const vectors=hit?.vectors??(inputs.length?await this.models.embed(embedding,inputs,signal):[]);let i=0;
      if(!hit&&vectors.length&&!signal?.aborted)this.embeddings.set(embeddingKey,{spaceId,dimensions:embedding.dimensions,vectors});
      if(original)queryVector=vectors[i++];
      const search=(ns:'chunks'|'entities'|'relations',v:number[],topK:number)=>{branches.push(ns);return view.search(ns,v,{spaceId,topK,threshold:query.cosineThreshold});};
      if(needLow){local=search('entities',vectors[i++]!,query.topK).flatMap(r=>{const n=view.node(r.id);return n?[n]:[];});localEdges=localRelations(view,local);}
      if(needHigh){global=search('relations',vectors[i]!,query.topK).flatMap(r=>{const e=view.edgeById(r.id);return e?[e]:[];});globalNodes=globalEntities(view,global);}
      if(query.mode==='naive'||query.mode==='mix')direct=search('chunks',queryVector!,query.chunkTopK).flatMap(r=>chunk(r.id,'vector'));
    }
    const allEntities=roundRobin([local,globalNodes],n=>n.id),allRelations=roundRobin([localEdges,global],e=>e.id);
    const graphTokens=(rows:Record<string,string>[])=>countTokens(rows.map(contextJson).join('\n'),text.tokenizer);
    let entities=prefixBudget(allEntities,query.maxEntityTokens,rows=>graphTokens(rows.map(entityRecord)));
    let relationships=prefixBudget(allRelations,query.maxRelationTokens,rows=>graphTokens(rows.map(e=>relationRecord(e,view))));
    // The complete request budget may further trim graph rows BEFORE selecting their source blocks.
    const graphContext=buildContext(view,query,text,entities,relationships,[]);entities=graphContext.entities;relationships=graphContext.relationships;
    const select=(sources:string[][],excluded:string[]=[])=>selectSources(sources,{method:query.kgChunkPickMethod,related:query.relatedChunkNumber,excluded,...(queryVector?{queryVector}:{}),vector:id=>view.getVector('chunks',id)?.values,warnings});
    const entityIds=select(entities.map(e=>e.sourceChunkIds));const relationIds=select(relationships.map(e=>e.sourceChunkIds),entityIds);
    const merged=roundRobin([direct,entityIds.flatMap(id=>chunk(id,'entity')),relationIds.flatMap(id=>chunk(id,'relationship'))],c=>c.id);
    let reranked=merged;
    if(query.enableRerank&&merged.length){const profile=boundProfile(config,'rerank');if(profile?.kind!=='rerank'||!profile.enabled)throw new ModelError('MODEL_NOT_CONFIGURED','请启用并配置重排模型',409);
      const result=await this.models.rerank(profile,query.query,merged.map(c=>c.content),signal,true);warnings.push(...result.warnings);
      reranked=result.results.filter(r=>result.warnings.length||r.score>=query.minRerankScore).map(r=>merged[r.index]!);
    }
    signal?.throwIfAborted();
    const final=buildContext(view,query,text,entities,relationships,reranked.slice(0,query.chunkTopK));
    const data=QueryDataSchema.parse({mode:query.mode,status:final.entities.length||final.relationships.length||final.chunks.length?'success':'empty',context:final.context,prompt:final.prompt,content:query.onlyNeedPrompt?final.prompt:final.context,
      entities:final.entities,relationships:final.relationships,chunks:final.chunks,references:final.references,warnings,
      diagnostics:{generation:view.generation,corpusRevision:view.corpusRevision,configRevision:config.revision,embeddingSpaceId:spaceId,embeddingConfigRevision:view.indexBinding?.configRevision??null,keywords,embeddingsCached,branches,
        recalled:{entities:allEntities.length,relationships:allRelations.length,chunks:direct.length},selectedEntityChunks:entityIds,selectedRelationChunks:relationIds,mergedChunkIds:merged.map(c=>c.id),
        truncated:{entities:allEntities.length-final.entities.length,relationships:allRelations.length-final.relationships.length,chunks:merged.length-final.chunks.length},budget:final.budget}});
    return {data,messages:final.messages};
  }
}
