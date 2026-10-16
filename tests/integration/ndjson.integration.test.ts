import {expect,it} from 'vitest';
import {generationHarness,generationHandler,isGeneration,collect,sseDelta,generationPost} from '../helpers/generation.js';
it('converts real fragmented UTF-8/CRLF/multiline SSE, empty/usage frames to ordered NDJSON and exactly one terminal',async()=>{
 const h=await generationHarness((request,response)=>{
  if(!isGeneration(request)){generationHandler(request,response);return;}
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  const payload=Buffer.from(': ping\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"中文 🧮 [1]"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{"content":""},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":5}}\n\ndata: [DONE]\n\n');
  let i=0;const timer=setInterval(()=>{if(i>=payload.length){clearInterval(timer);response.end();return;}response.write(payload.subarray(i,i+2));i+=2;},1);response.on('close',()=>clearInterval(timer));
 });try{
  const address=await h.app.listen({host:'127.0.0.1',port:0});const response=await fetch(`${address}/api/v1/query/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'Alpha?'})});expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const frames=await collect(response);expect(frames.map(e=>e.type)).toEqual(['meta','references','delta','done']);expect(frames[2]).toEqual({type:'delta',text:'中文 🧮 [1]'});expect(frames.filter(e=>['done','error','cancelled'].includes(e.type))).toHaveLength(1);
 }finally{await h.close();}
});
it('converts a JSON model response requested as streaming and replays a complete cache entry through the same protocol',async()=>{
 const h=await generationHarness();try{
  for(const cached of [false,true]){const r=await generationPost(h,'/api/v1/query/stream',{query:'Alpha?'});const frames=await collect(r);expect(frames.map(e=>e.type)).toEqual(['meta','references','delta','done']);expect(frames[0]).toMatchObject({cached});expect(frames.at(-1)).toMatchObject({type:'done',cached,finishReason:'stop'});}
  expect(h.model.requests.filter(isGeneration)).toHaveLength(1);
 }finally{await h.close();}
});
it('reports model EOF/protocol failures as error, never done or a cached partial answer',async()=>{
 const h=await generationHarness((request,response)=>{if(isGeneration(request)){response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(sseDelta('partial [1]'));}else generationHandler(request,response);});try{
  const {events}=await import('../helpers/generation.js');
  for(let i=0;i<2;i++){const r=await h.app.inject({method:'POST',url:'/api/v1/query/stream',payload:{query:'Alpha?'}});const frames=events(r.body);expect(frames.map(e=>e.type)).toEqual(['meta','references','delta','error']);expect(frames.at(-1)).toMatchObject({type:'error',error:{code:'INVALID_MODEL_RESPONSE'}});}
  expect(h.model.requests.filter(isGeneration)).toHaveLength(2);
 }finally{await h.close();}
});
it('does not retry after a delivered delta when the upstream connection breaks',async()=>{
 const h=await generationHarness((request,response)=>{if(isGeneration(request)){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write(sseDelta('once [1]'));setTimeout(()=>response.destroy(),20);}else generationHandler(request,response);});try{
  const settings=(await h.app.inject({url:'/api/v1/settings/models'})).json() as {revision:number;profiles:Record<string,unknown>[];bindings:unknown};const profiles=settings.profiles.map(p=>{const copy={...p};delete copy.hasApiKey;return p.kind==='text'?{...copy,maxRetries:2}:copy;});
  expect((await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:settings.revision,profiles,bindings:settings.bindings}})).statusCode).toBe(200);
  const r=await h.app.inject({method:'POST',url:'/api/v1/query/stream',payload:{query:'Alpha?'}});const {events}=await import('../helpers/generation.js');const frames=events(r.body);expect(frames.filter(e=>e.type==='delta')).toHaveLength(1);expect(frames.at(-1)?.type).toBe('error');expect(h.model.requests.filter(isGeneration)).toHaveLength(1);
 }finally{await h.close();}
});
