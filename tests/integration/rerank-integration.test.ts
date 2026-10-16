import {expect,it} from 'vitest';
import {retrievalHarness,queryHandler,reference} from '../helpers/retrieval.js';
import {textProfile,embeddingProfile,rerankProfile,bindings} from '../helpers/model-profiles.js';
import {QueryDataSchema} from '@tslightrag/contracts';
it('applies actual rerank indices/order/topN before chunkTopK/budget, validates indices and obeys fail versus warning policy',async()=>{
 let fault=false;
 const h=await retrievalHarness((request,response)=>{
  const body=request.body as {documents?:string[];top_n?:number};
  if(body.documents){const size=body.top_n!;response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({results:Array.from({length:size},(_,i)=>({index:fault?0:body.documents!.length-1-i,relevance_score:0.9-i*0.1}))}));}
  else queryHandler(request,response);
 });try{
  const doc=await h.import('second document for reranking');expect((await h.wait(doc.job.id)).status).toBe('processed');
  const save=async(revision:number,policy:'fail'|'fallback-with-warning',topN=2)=>{
   const r=await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:revision,profiles:[textProfile(h.model.url),embeddingProfile(h.model.url),rerankProfile(h.model.url,{enabled:true,failurePolicy:policy,topN})],bindings}});expect(r.statusCode,r.body).toBe(200);
  };
  const call=(extra:Record<string,unknown>={})=>h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',mode:'mix',enableRerank:true,cosineThreshold:-1,...extra}});
  await save(1,'fail');
  const first=await call({chunkTopK:1});expect(first.statusCode,first.body).toBe(200);const result=QueryDataSchema.parse(first.json());expect(result.chunks).toHaveLength(1);
  const original=['z','a'];const expected=reference.processing.find(p=>p.limit===10000)!.chunks;expect(result.chunks.map(c=>c.id)).toEqual(expected.slice(0,1).map(id=>result.diagnostics.mergedChunkIds[original.indexOf(id)]));
  const request=h.model.requests.filter(r=>(r.body as {documents?:unknown}).documents).at(-1)!;expect((request.body as {documents:unknown[]}).documents).toHaveLength(2);
  fault=true;const invalid=await call();expect(invalid.statusCode).toBe(502);expect(invalid.json().code).toBe('INVALID_MODEL_RESPONSE');
  await save(2,'fallback-with-warning');const fallback=await call();expect(fallback.statusCode,fallback.body).toBe(200);const data=QueryDataSchema.parse(fallback.json());expect(data.warnings).toHaveLength(1);expect(data.chunks.map(c=>c.id)).toEqual(data.diagnostics.mergedChunkIds);
  fault=false;await save(3,'fail',1);const top=await call();expect(top.statusCode,top.body).toBe(200);expect(top.json().chunks).toHaveLength(1);
  const none=await call({minRerankScore:1});expect(none.statusCode,none.body).toBe(200);expect(none.json().chunks).toEqual([]);
 }finally{await h.close();}
});
