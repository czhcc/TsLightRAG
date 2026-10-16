import { useEffect, useRef, useState } from 'react';
import { ApiErrorSchema, QueryDataSchema } from '@tslightrag/contracts';
import type { QueryData } from '@tslightrag/contracts';
export function QueryPreview(){
  const [query,setQuery]=useState(''),[mode,setMode]=useState('mix'),[method,setMethod]=useState('VECTOR'),[related,setRelated]=useState(5),[rerank,setRerank]=useState(false);
  const [result,setResult]=useState<QueryData|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>pending.current?.abort(),[]);
  async function submit(){
    const controller=new AbortController();pending.current=controller;setBusy(true);setError('');setResult(null);
    try{
      const response=await fetch('/api/v1/query/data',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({query,mode,kgChunkPickMethod:method,relatedChunkNumber:related,enableRerank:rerank,onlyNeedContext:true})});
      if(!response.ok){const payload=ApiErrorSchema.safeParse(await response.json());throw new Error(payload.success?payload.data.message:'检索请求失败');}
      const data=QueryDataSchema.parse(await response.json());if(!controller.signal.aborted)setResult(data);
    }catch(e){setError(controller.signal.aborted?'检索已取消':e instanceof Error?e.message:'检索请求失败');}
    finally{pending.current=null;setBusy(false);}
  }
  return <section aria-label="检索预览">
    <p>检索文档证据并预览上下文；本阶段不生成回答。</p>
    <form onSubmit={e=>{e.preventDefault();void submit();}}>
      <label>检索问题<textarea value={query} onChange={e=>setQuery(e.target.value)} maxLength={20000} required disabled={busy}/></label>
      <label>检索模式<select value={mode} onChange={e=>setMode(e.target.value)} disabled={busy}>{['naive','local','global','hybrid','mix'].map(m=><option key={m}>{m}</option>)}</select></label>
      <label>来源块选择<select value={method} onChange={e=>setMethod(e.target.value)} disabled={busy}><option>VECTOR</option><option>WEIGHT</option></select></label>
      <label>关联块数量<input type="number" min="0" max="100" value={related} onChange={e=>setRelated(Number(e.target.value))} disabled={busy}/></label>
      <label><input type="checkbox" checked={rerank} onChange={e=>setRerank(e.target.checked)} disabled={busy}/>启用重排</label>
      <button disabled={busy||!query.trim()} type="submit">检索证据</button>{busy&&<button type="button" onClick={()=>pending.current?.abort()}>取消检索</button>}
    </form>
    {busy&&<p role="status">正在检索…</p>}{error&&<p role="alert">{error}</p>}
    {result&&<div aria-label="检索结果">
      <p role="status">{result.status==='empty'?'没有检索到证据':`找到 ${String(result.chunks.length)} 个文本块、${String(result.entities.length)} 个实体、${String(result.relationships.length)} 条关系`}</p>
      {result.warnings.map((w,i)=><p role="alert" key={i}>{w}</p>)}
      <h2>来源证据</h2>{result.references.map(r=><article key={r.id}><h3>[{r.id}] {r.fileName}</h3>{result.chunks.filter(c=>c.referenceId===r.id).map(c=><div key={c.id}><p>文档版本 {c.docVersion} · 块 {c.order+1} · {c.source}</p>{c.location&&<details><summary>原始位置</summary><pre>{c.location}</pre></details>}<pre>{c.content}</pre></div>)}</article>)}
      <details><summary>上下文与预算</summary><pre>{result.context}</pre><pre>{JSON.stringify(result.diagnostics,null,2)}</pre></details>
      <details><summary>完整提示词预览</summary><pre>{result.prompt}</pre></details>
    </div>}
  </section>;
}
