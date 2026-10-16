import {expect,it} from 'vitest';
import {QueryResponseSchema} from '@tslightrag/contracts';
import {generationHarness,generationHandler,isGeneration,generationPost,collect,sseDelta,sseDone,readUntil,remaining} from '../helpers/generation.js';
import {maintain,candidate} from '../helpers/maintenance.js';
import {textProfile,embeddingProfile,rerankProfile,bindings} from '../helpers/model-profiles.js';
async function answer(h:Awaited<ReturnType<typeof generationHarness>>,extra:Record<string,unknown>={}){const r=await generationPost(h,'/api/v1/query',{query:'Alpha?',...extra});expect(r.status,await r.clone().text()).toBe(200);return QueryResponseSchema.parse(await r.json());}
it('hits a complete answer without any model request; separately reuses bounded keyword/query-embedding caches',async()=>{
 const h=await generationHarness();try{
  const first=await answer(h);expect(first.cached).toBe(false);const count=h.model.requests.length;
  const hit=await answer(h);expect(hit.cached).toBe(true);expect(hit.answer).toBe(first.answer);expect(h.model.requests).toHaveLength(count);
  const data=await generationPost(h,'/api/v1/query/data',{query:'Alpha?'});expect(data.status).toBe(200);const result=await data.json() as {diagnostics:{keywords:{cached:boolean};embeddingsCached:boolean}};expect(result.diagnostics.keywords.cached).toBe(true);expect(result.diagnostics.embeddingsCached).toBe(true);expect(h.model.requests).toHaveLength(count);
  const stream=await collect(await generationPost(h,'/api/v1/query/stream',{query:'Alpha?'}));expect(stream[0]).toMatchObject({cached:true});expect(h.model.requests).toHaveLength(count);
 }finally{await h.close();}
});
it('keys answer options by history/instructions/budgets/mode/thresholds/rerank and configured model identity',async()=>{
 const h=await generationHarness((request,response)=>{const body=request.body as {documents?:string[];top_n?:number};if(body.documents)response.end(JSON.stringify({results:Array.from({length:body.top_n!},(_,index)=>({index,relevance_score:0.9}))}));else generationHandler(request,response);});try{
  const save=await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:1,profiles:[textProfile(h.model.url),embeddingProfile(h.model.url),rerankProfile(h.model.url,{enabled:true,topN:1})],bindings}});expect(save.statusCode,save.body).toBe(200);
  await answer(h);expect((await answer(h)).cached).toBe(true);
  for(const extra of [{conversationHistory:[{role:'user',content:'earlier'}]},{userPrompt:'in Chinese'},{maxTotalTokens:16001},{maxEntityTokens:5000},{maxRelationTokens:7000},{topK:3},{chunkTopK:3},{cosineThreshold:0},{mode:'naive'},{kgChunkPickMethod:'WEIGHT'},{relatedChunkNumber:1},{enableRerank:true},{minRerankScore:0.7}])expect((await answer(h,extra)).cached).toBe(false);
  const changed=await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:2,profiles:[textProfile(h.model.url,{model:'query-next'}),embeddingProfile(h.model.url),rerankProfile(h.model.url,{enabled:true,topN:1})],bindings}});expect(changed.statusCode,changed.body).toBe(200);expect((await answer(h)).cached).toBe(false);
  expect((h.model.requests.filter(isGeneration).at(-1)!.body as {model:string}).model).toBe('query-next');
 }finally{await h.close();}
});
it('invalidates after deletion/version replacement, byte-identical rebuild and embedding-space activation',async()=>{
 const h=await generationHarness();try{
  const initial=h.storage.capture().documents().find(d=>d.status==='processed')!;const second=await h.import('second document for caching');await h.wait(second.job.id);
  await answer(h);expect((await answer(h)).cached).toBe(true);
  const del=await maintain(h,'delete',second.document.id);await h.wait(del.id);const afterDelete=await answer(h);expect(afterDelete.cached).toBe(false);expect(afterDelete.references.every(r=>r.documentId!==second.document.id)).toBe(true);
  const replacement=await maintain(h,'reindex',initial.id,{replacement:{name:'new.txt',text:'replacement content Alpha'}});await h.wait(replacement.id);const replaced=await answer(h);expect(replaced.cached).toBe(false);expect(replaced.data.chunks.every(c=>c.docVersion===2)).toBe(true);
  expect((await answer(h)).cached).toBe(true);const revision=h.storage.capture().corpusRevision;
  const rebuild=await maintain(h,'rebuild',undefined,{targetProfileId:'embedding'});expect((await h.wait(rebuild.id)).status).toBe('processed');expect(h.storage.capture().corpusRevision).toBeGreaterThan(revision);expect((await answer(h)).cached).toBe(false);
  await candidate(h,{model:'activated-next',operatorRevision:1});const switchJob=await maintain(h,'rebuild',undefined,{targetProfileId:'embedding'});await h.wait(switchJob.id);const switched=await answer(h);expect(switched.cached).toBe(false);expect(switched.data.diagnostics.embeddingSpaceId).not.toBe(replaced.data.diagnostics.embeddingSpaceId);
 }finally{await h.close();}
});
it('does not install an old in-flight generation into the new corpus cache after deletion',async()=>{
 let held:Parameters<typeof generationHandler>[1]|undefined,hold=true;
 const h=await generationHarness((request,response)=>{if(hold&&isGeneration(request)){held=response;response.writeHead(200,{'Content-Type':'text/event-stream'});response.write(sseDelta('old evidence [1]'));}else generationHandler(request,response);});try{
  const response=await generationPost(h,'/api/v1/query/stream',{query:'Alpha?'});const cursor=await readUntil(response,e=>e.type==='delta');
  const clear=await maintain(h,'clear');await h.wait(clear.id);held!.end(sseDone);expect((await remaining(cursor)).at(-1)?.type).toBe('done');hold=false;
  const next=await answer(h);expect(next.cached).toBe(false);expect(next.status).toBe('empty');expect(next.references).toEqual([]);expect(h.model.requests.filter(isGeneration)).toHaveLength(1);
 }finally{held?.end();await h.close();}
});
