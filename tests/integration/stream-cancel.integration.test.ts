import {expect,it} from 'vitest';
import {generationHarness,generationHandler,isGeneration,generationPost,readUntil,remaining,sseDelta,collect} from '../helpers/generation.js';
it('explicit stop produces cancelled once, aborts upstream, never caches a partial stream, then permits a fresh answer',async()=>{
 let hold=true,closed=false;
 const h=await generationHarness((request,response)=>{if(hold&&isGeneration(request)){response.on('close',()=>{closed=true;});response.writeHead(200,{'Content-Type':'text/event-stream'});response.write(sseDelta('部分 [1]'));}else generationHandler(request,response);});try{
  const response=await generationPost(h,'/api/v1/query/stream',{query:'Alpha?'});const cursor=await readUntil(response,e=>e.type==='delta');const meta=cursor.seen.find(e=>e.type==='meta');if(meta?.type!=='meta')throw new Error('Missing meta');
  const cancel=await generationPost(h,`/api/v1/query/${meta.requestId}/cancel`,{});expect(await cancel.json()).toEqual({cancelled:true});
  const frames=await remaining(cursor);expect(frames.map(e=>e.type)).toEqual(['meta','references','delta','cancelled']);await expect.poll(()=>closed).toBe(true);
  hold=false;const next=await generationPost(h,'/api/v1/query/stream',{query:'Alpha?'});const fresh=await collect(next);expect(fresh[0]).toMatchObject({cached:false});expect(fresh.at(-1)?.type).toBe('done');expect(h.model.requests.filter(isGeneration)).toHaveLength(2);
 }finally{await h.close();}
});
it('client fetch abort closes the model request and cannot publish a partial answer cache entry',async()=>{
 let hold=true,closed=false;
 const h=await generationHarness((request,response)=>{if(hold&&isGeneration(request)){response.on('close',()=>{closed=true;});response.writeHead(200,{'Content-Type':'text/event-stream'});response.write(sseDelta('partial [1]'));}else generationHandler(request,response);});const controller=new AbortController();try{
  const response=await generationPost(h,'/api/v1/query/stream',{query:'disconnect test'},controller.signal);const cursor=await readUntil(response,e=>e.type==='delta');controller.abort();await cursor.reader.cancel().catch(()=>{});cursor.reader.releaseLock();await expect.poll(()=>closed).toBe(true);
  hold=false;const fresh=await generationPost(h,'/api/v1/query',{query:'disconnect test'});expect(fresh.status).toBe(200);expect((await fresh.json() as {cached:boolean}).cached).toBe(false);expect(h.model.requests.filter(isGeneration)).toHaveLength(2);
 }finally{controller.abort();await h.close();}
});
it('timeout is an error terminal, and stopping a completed request cannot add a second terminal',async()=>{
 let hold=true;const h=await generationHarness((request,response)=>{if(hold&&isGeneration(request)){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write(sseDelta('partial [1]'));}else generationHandler(request,response);});try{
  const current=(await h.app.inject({url:'/api/v1/settings/models'})).json() as {revision:number;profiles:Record<string,unknown>[];bindings:unknown};const profiles=current.profiles.map(p=>{const next={...p};delete next.hasApiKey;return p.kind==='text'?{...next,timeoutMs:200}:next;});
  expect((await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:current.revision,profiles,bindings:current.bindings}})).statusCode).toBe(200);
  const timeout=await collect(await generationPost(h,'/api/v1/query/stream',{query:'timeout'}));expect(timeout.at(-1)).toMatchObject({type:'error',error:{code:'MODEL_TIMEOUT'}});expect(timeout.filter(e=>['done','cancelled','error'].includes(e.type))).toHaveLength(1);
  hold=false;const done=await collect(await generationPost(h,'/api/v1/query/stream',{query:'completed'}));const meta=done[0];if(meta?.type!=='meta')throw new Error('Missing meta');expect(done.at(-1)?.type).toBe('done');
  await expect.poll(async()=>await(await generationPost(h,`/api/v1/query/${meta.requestId}/cancel`,{})).json()).toEqual({cancelled:false});
 }finally{await h.close();}
});
