import { useEffect, useRef, useState } from 'react';
import { SafeMarkdown } from './SafeMarkdown.js';
import { readNdjson } from './api/ndjson.js';
import { ApiErrorSchema, QueryDataSchema } from '@tslightrag/contracts';
import type { QueryData, QueryResponse } from '@tslightrag/contracts';
export function QueryPreview(){
  const [query,setQuery]=useState(''),[mode,setMode]=useState('mix'),[method,setMethod]=useState('VECTOR'),[related,setRelated]=useState(5),[rerank,setRerank]=useState(false);
  const [result,setResult]=useState<QueryData|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [answer,setAnswer]=useState(''),[answerState,setAnswerState]=useState(''),[answerWarnings,setAnswerWarnings]=useState<string[]>([]),[answerRefs,setAnswerRefs]=useState<QueryResponse['references']>([]);
  const streamId=useRef<string|null>(null);
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>pending.current?.abort(),[]);
  async function submit(){
    const controller=new AbortController();pending.current=controller;setBusy(true);setError('');setResult(null);setAnswer('');setAnswerState('');setAnswerWarnings([]);setAnswerRefs([]);
    try{
      const response=await fetch('/api/v1/query/data',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({query,mode,kgChunkPickMethod:method,relatedChunkNumber:related,enableRerank:rerank,onlyNeedContext:true})});
      if(!response.ok){const payload=ApiErrorSchema.safeParse(await response.json());throw new Error(payload.success?payload.data.message:'检索请求失败');}
      const data=QueryDataSchema.parse(await response.json());if(!controller.signal.aborted)setResult(data);
    }catch(e){setError(controller.signal.aborted?'检索已取消':e instanceof Error?e.message:'检索请求失败');}
    finally{pending.current=null;setBusy(false);}
  }
  async function generate(){
    const controller=new AbortController();pending.current=controller;streamId.current=null;
    setBusy(true);setError('');setResult(null);setAnswer('');setAnswerWarnings([]);setAnswerRefs([]);setAnswerState('正在生成回答…');
    try{
      const response=await fetch('/api/v1/query/stream',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({query,mode,kgChunkPickMethod:method,relatedChunkNumber:related,enableRerank:rerank})});
      if(!response.ok){const parsed=ApiErrorSchema.safeParse(await response.json());throw new Error(parsed.success?parsed.data.message:'回答请求失败');}
      await readNdjson(response,event=>{
        if(controller.signal.aborted)return;
        if(event.type==='meta')streamId.current=event.requestId;
        if(event.type==='references')setAnswerRefs(event.references);
        if(event.type==='delta')setAnswer(text=>text+event.text);
        if(event.type==='done'){setAnswerState(event.status==='empty'?'没有检索到证据':event.finishReason==='length'?'回答达到输出上限':event.cached?'回答完成（缓存）':'回答完成');setAnswerWarnings(event.warnings);if(event.data)setResult(event.data);}
        if(event.type==='error'){setAnswerState('回答失败；已显示的内容可能不完整');setError(event.error.message);}
        if(event.type==='cancelled')setAnswerState('回答已取消；已显示的内容可能不完整');
      });
    }catch(e){setAnswerState(controller.signal.aborted?'回答已取消；已显示的内容可能不完整':'回答失败；已显示的内容可能不完整');if(!controller.signal.aborted)setError(e instanceof Error?e.message:'回答请求失败');}
    finally{pending.current=null;streamId.current=null;setBusy(false);}
  }
  function stop(){
    if(streamId.current)void fetch(`/api/v1/query/${encodeURIComponent(streamId.current)}/cancel`,{method:'POST'}).catch(()=>{});
    pending.current?.abort();
  }
  return <section aria-label="检索预览">
    <p>检索文档证据或生成带来源的回答；模型使用你配置的接口。</p>
    <form onSubmit={e=>{e.preventDefault();void submit();}}>
      <label>检索问题<textarea value={query} onChange={e=>setQuery(e.target.value)} maxLength={20000} required disabled={busy}/></label>
      <label>检索模式<select value={mode} onChange={e=>setMode(e.target.value)} disabled={busy}>{['naive','local','global','hybrid','mix'].map(m=><option key={m}>{m}</option>)}</select></label>
      <label>来源块选择<select value={method} onChange={e=>setMethod(e.target.value)} disabled={busy}><option>VECTOR</option><option>WEIGHT</option></select></label>
      <label>关联块数量<input type="number" min="0" max="100" value={related} onChange={e=>setRelated(Number(e.target.value))} disabled={busy}/></label>
      <label><input type="checkbox" checked={rerank} onChange={e=>setRerank(e.target.checked)} disabled={busy}/>启用重排</label>
      <button disabled={busy||!query.trim()} type="submit">检索证据</button> <button disabled={busy||!query.trim()} type="button" onClick={()=>void generate()}>生成回答</button>{busy&&<button type="button" onClick={stop}>{answerState?'停止生成':'取消检索'}</button>}
    </form>
    {busy&&!answerState&&<p role="status">正在检索…</p>}{error&&<p role="alert">{error}</p>}
    {answerState&&<section aria-label="知识库回答"><h2>知识库回答</h2><p role="status">{answerState}</p><SafeMarkdown content={answer} />{answerWarnings.map((w,i)=><p role="alert" key={i}>{w}</p>)}<ul>{answerRefs.map(r=><li key={r.id}><details><summary>[{r.id}] {r.fileName}</summary>{r.location && <p>{r.location}</p>}{r.content && <pre>{r.content}</pre>}<a href={`/documents?id=${encodeURIComponent(r.documentId)}`}>查看来源文档</a></details></li>)}</ul></section>}
    {result&&<div aria-label="检索结果">
      <p role="status">{result.status==='empty'?'没有检索到证据':`找到 ${String(result.chunks.length)} 个文本块、${String(result.entities.length)} 个实体、${String(result.relationships.length)} 条关系`}</p>
      {result.warnings.map((w,i)=><p role="alert" key={i}>{w}</p>)}
      <h2>来源证据</h2>{result.references.map(r=><article key={r.id}><h3>[{r.id}] {r.fileName}</h3><a href={`/documents?id=${encodeURIComponent(r.documentId)}`}>查看来源文档</a>{result.chunks.filter(c=>c.referenceId===r.id).map(c=><div key={c.id}><p>文档版本 {c.docVersion} · 块 {c.order+1} · {c.source}</p>{c.location&&<details><summary>原始位置</summary><pre>{c.location}</pre></details>}<pre>{c.content}</pre></div>)}</article>)}
      <details><summary>上下文与预算</summary><pre>{result.context}</pre><pre>{JSON.stringify(result.diagnostics,null,2)}</pre></details>
      <details><summary>完整提示词预览</summary><pre>{result.prompt}</pre></details>
    </div>}
  </section>;
}
