import {expect,it} from 'vitest';
import {QueryDataSchema} from '@tslightrag/contracts';
import {retrievalHarness,queryHandler,reference} from '../helpers/retrieval.js';
import {reply} from '../helpers/indexing.js';
import {candidate} from '../helpers/maintenance.js';
import type {ModelRequest} from '../helpers/fake-model.js';
it('validates requests and returns structured evidence, real snapshot diagnostics, and previews without answer generation',async()=>{
 const h=await retrievalHarness();try{
  for(const payload of [{query:''},{query:'x',mode:'bad'},{query:'x',relatedChunkNumber:-1},{query:'x',onlyNeedContext:true,onlyNeedPrompt:true}])expect((await h.app.inject({method:'POST',url:'/api/v1/query/data',payload})).statusCode).toBe(400);
  const before=h.storage.capture();const response=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',onlyNeedPrompt:true}});
  expect(response.statusCode,response.body).toBe(200);const result=QueryDataSchema.parse(response.json());
  expect(result.content).toBe(result.prompt);expect(result.prompt).toContain(result.context);expect(result.diagnostics.generation).toBe(before.generation);expect(h.storage.capture().generation).toBe(before.generation);
  expect(JSON.stringify(result)).not.toContain('synthetic-s03-secret');
  const messages=h.model.requests.filter(r=>(r.body as {messages?:unknown}).messages);expect(messages).toHaveLength(3); // extract + glean + keyword, no answer
 }finally{await h.close();}
});
it('uses the active index embedding profile even after the candidate changes dimensions and model',async()=>{
 const h=await retrievalHarness();try{
  const binding=h.storage.capture().indexBinding!;await candidate(h,{model:'not-activated',dimensions:3});
  const response=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',mode:'mix'}});expect(response.statusCode,response.body).toBe(200);
  const result=QueryDataSchema.parse(response.json());expect(result.diagnostics.embeddingSpaceId).toBe(binding.spaceId);expect(result.diagnostics.embeddingConfigRevision).toBe(binding.configRevision);
  const request=h.model.requests.filter(r=>(r.body as {input?:unknown}).input).at(-1)!;expect((request.body as {model:string}).model).toBe('embedding-model');
 }finally{await h.close();}
});
it('matches upstream empty-keyword Unicode/50-character fallback boundary and cross-mode keyword fallback',async()=>{
 let high:string[]=[];let low:string[]=[];
 const h=await retrievalHarness((request,response)=>{
  if((request.body as {messages?:{content:string}[]}).messages?.some(m=>m.content.includes('expert keyword extractor')))reply(response,{high_level_keywords:high,low_level_keywords:low});else queryHandler(request,response);
 });try{
  for(const c of reference.fallback){const response=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:c.query}});expect(response.statusCode,response.body).toBe(200);const r=QueryDataSchema.parse(response.json());
   if(c.content==='no-result'){expect(r.status).toBe('empty');expect(r.diagnostics.branches).toEqual([]);}else{expect(r.diagnostics.keywords.low).toEqual([c.query]);expect(r.diagnostics.branches).toEqual(['entities','chunks']);}
  }
  high=['theme'];const global=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'only high',mode:'local'}});expect(global.json().diagnostics.branches).toEqual(['relations']);
  high=[];low=['Alpha'];const local=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'only low',mode:'global'}});expect(local.json().diagnostics.branches).toEqual(['entities']);
 }finally{await h.close();}
});
it('rejects invalid/truncated keyword JSON, never caches it, and propagates model outages as errors',async()=>{
 let fault='invalid';const h=await retrievalHarness((request,response)=>{
  if((request.body as {messages?:{content:string}[]}).messages?.some(m=>m.content.includes('expert keyword extractor'))){
   if(fault==='outage')response.writeHead(503).end('{}');else reply(response,fault==='invalid'?'not-json':{high_level_keywords:['theme'],low_level_keywords:['Alpha']},fault==='length'?'length':'stop');
  }else queryHandler(request,response);
 });try{
  for(const mode of ['invalid','length','outage','valid']){fault=mode;const response=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'same query'}});expect(response.statusCode,response.body).toBe(mode==='valid'?200:502);if(mode==='valid')expect(response.json().diagnostics.keywords.cached).toBe(false);}
 }finally{await h.close();}
});
export function inputs(request:ModelRequest){return (request.body as {input?:string[]}).input;}
it('holds a complete reader snapshot across concurrent corpus deletion and does not cache old evidence',async()=>{
 const {maintain}=await import('../helpers/maintenance.js');
 let held:Parameters<typeof reply>[0]|undefined;
 const h=await retrievalHarness((request,response)=>{
  if((request.body as {messages?:{content:string}[]}).messages?.some(m=>m.content.includes('expert keyword extractor')))held=response;else queryHandler(request,response);
 });try{
  const generation=h.storage.capture().generation;
  const pending=h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'held query'}}).then(r=>r);
  await expect.poll(()=>Boolean(held)).toBe(true);
  const clear=await maintain(h,'clear');expect((await h.wait(clear.id)).status).toBe('processed');
  reply(held!,{high_level_keywords:['theme'],low_level_keywords:['Alpha']});
  const r=await pending;expect(r.statusCode,r.body).toBe(200);expect(r.json().diagnostics.generation).toBe(generation);expect(r.json().chunks.length).toBeGreaterThan(0);
  const next=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'held query'}});expect(next.statusCode,next.body).toBe(200);expect(next.json().chunks).toEqual([]);expect(next.json().references).toEqual([]);
 }finally{if(held&&!held.writableEnded)held.end();await h.close();}
});
