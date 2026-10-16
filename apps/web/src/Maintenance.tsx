import { useEffect, useRef, useState } from 'react';
import { ApiErrorSchema, JobSchema, ModelSettingsSchema, MaintenanceStateSchema } from '@tslightrag/contracts';
import type { z } from 'zod';
import type { DocumentRecord, JobRecord, ModelSettings } from '@tslightrag/contracts';
type State=z.infer<typeof MaintenanceStateSchema>;
const running=(j:JobRecord)=>['queued','parsing','chunking','extracting','embedding','committing'].includes(j.status);
export function MaintenancePanel({document,onChanged,onDeleted}:{document:DocumentRecord|null;onChanged:()=>void;onDeleted:()=>void}) {
  const [state,setState]=useState<State|null>(null);const [models,setModels]=useState<ModelSettings|null>(null);const [target,setTarget]=useState('');
  const [message,setMessage]=useState('');const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [replacement,setReplacement]=useState('');
  const pending=useRef<{id:string;deleting:boolean}|null>(null); const callbacks=useRef({onChanged,onDeleted});callbacks.current={onChanged,onDeleted};
  const controller=useRef<AbortController|null>(null);useEffect(()=>()=>{controller.current?.abort();},[]);
  useEffect(()=>{setConfirmed(false);setReplacement('');},[document?.id]);
  useEffect(()=>{const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{
      const [a,b]=await Promise.all([fetch('/api/v1/maintenance',{signal:abort.signal}),fetch('/api/v1/settings/models',{signal:abort.signal})]);
      if(!a.ok||!b.ok)throw new Error('维护状态加载失败');
      const value=MaintenanceStateSchema.parse(await a.json());const config=ModelSettingsSchema.parse(await b.json());
      if(abort.signal.aborted)return;setState(value);setModels(config);
      const current=pending.current?value.jobs.find((j)=>j.id===pending.current!.id):undefined;
      if(current&&!running(current)) {const old=pending.current;pending.current=null;setMessage(current.status==='processed'?'维护已完成':`${current.status}：${current.error??''}`);callbacks.current.onChanged();if(current.status==='processed'&&old?.deleting)callbacks.current.onDeleted();}
    }catch(e){if(!abort.signal.aborted)setMessage(e instanceof Error?e.message:'维护状态加载失败');}
    finally{if(!abort.signal.aborted)timer=setTimeout(()=>{void load();},1000);}};void load();return()=>{abort.abort();clearTimeout(timer);};},[]);
  const perform=async(path:string,method:string,extra:Record<string,unknown>={},deleting=false)=>{
    if(!state||!models)return;controller.current?.abort();const abort=new AbortController();controller.current=abort;setBusy(true);setMessage('');
    try{const response=await fetch(`/api/v1${path}`,{method,signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedCorpusRevision:state.corpusRevision,expectedConfigRevision:models.revision,...(document?{expectedDocumentVersion:document.version}:{}),...extra})});
      const value:unknown=await response.json();if(!response.ok){const error=ApiErrorSchema.safeParse(value);throw new Error(error.success?error.data.message:'维护请求失败');}
      const job=JobSchema.parse(value);pending.current={id:job.id,deleting};setMessage('维护任务已保存；完成前继续使用旧索引。');callbacks.current.onChanged();
    }catch(e){if(!abort.signal.aborted)setMessage(e instanceof Error?e.message:'维护请求失败');}finally{if(!abort.signal.aborted)setBusy(false);}
  };
  const simple=async(path:string,message:string)=>{
    controller.current?.abort();const abort=new AbortController();controller.current=abort;setBusy(true);
    try{const response=await fetch(`/api/v1${path}`,{method:'POST',signal:abort.signal});if(!response.ok){const error=ApiErrorSchema.parse(await response.json());throw new Error(error.message);}setMessage(message);}
    catch(e){if(!abort.signal.aborted)setMessage(e instanceof Error?e.message:'操作失败');}finally{if(!abort.signal.aborted)setBusy(false);}
  };
  const active=state?.jobs.some(running)??false;
  return <section aria-label="索引维护"><h2>索引维护</h2>
    <p>活动向量模型：{state?.activeIndex?`${state.activeIndex.profile.model}（配置版本 ${String(state.activeIndex.configRevision)}）`:'尚无活动索引'}。保存候选配置不会切换已有向量。</p>
    <p>维护可能将存活文本发送到已配置的模型接口，产生费用。失败或取消时保留旧索引。</p>
    <label>目标向量模型<select value={target} onChange={(e)=>{setTarget(e.target.value);}}><option value="">请选择已保存模型</option>{models?.profiles.filter((p)=>p.kind==='embedding').map((p)=><option key={p.id} value={p.id}>{p.name} · {p.model} · {p.kind==='embedding'?p.dimensions:0} 维</option>)}</select></label>
    <button disabled={busy||active||!target} onClick={()=>{void perform('/maintenance/rebuild','POST',{targetProfileId:target});}}>重建三类向量并切换</button>
    {document&&<><h3>当前文档：{document.name} · 版本 {document.version}</h3>
      <label>替换正文（可选；留空沿用原文件）<textarea value={replacement} onChange={(e)=>{setReplacement(e.target.value);}} /></label>
      <button disabled={busy||active||document.status!=='processed'} onClick={()=>{void perform(`/documents/${document.id}/reindex`,'POST',replacement?{replacement:{name:'replacement.txt',text:replacement}}:{});}}>重新索引文档</button></>}
    <label><input type="checkbox" checked={confirmed} onChange={(e)=>{setConfirmed(e.target.checked);}} />确认删除所选内容及其索引贡献</label>
    {document&&<button disabled={busy||active||!confirmed} onClick={()=>{void perform(`/documents/${document.id}`,'DELETE',{},true);}}>删除当前文档</button>}
    <button disabled={busy||active||!confirmed} onClick={()=>{void perform('/documents','DELETE',{},true);}}>清空全部文档</button>
    <p role="status">{message}</p>
    {state?.jobs.slice(0,5).map((j)=><p key={j.id}>{j.operation} · {j.status} · {j.phase} {j.error&&`${j.errorCode??''}：${j.error}`}{running(j)&&<button onClick={()=>{void simple(`/jobs/${j.id}/cancel`,'已请求取消维护');}}>取消维护任务</button>}{['failed','cancelled','interrupted'].includes(j.status)&&<button disabled={busy||active} onClick={()=>{void perform(`/jobs/${j.id}/retry`,'POST',{...(j.maintenance?.targetProfileId?{targetProfileId:j.maintenance.targetProfileId}:{}),...(j.maintenance?.sourceVersion?{expectedDocumentVersion:j.maintenance.sourceVersion}:{})},j.operation==='delete');}}>重试维护任务</button>}</p>)}
    <p>文件释放任务：{state?.cleanupTasks.filter((t)=>t.status!=='done').length??0} 项待处理。保留快照仍引用文件时会延后释放。</p>
    <button onClick={()=>{void simple('/maintenance/cleanup','已重新检查文件引用');}}>重试文件释放</button>
  </section>;
}
