import {expect,it} from 'vitest';
import {QueryDataSchema} from '@tslightrag/contracts';
import {retrievalHarness} from '../helpers/retrieval.js';
it('executes distinct vector/entity/relation branches for all five modes over real indexed data',async()=>{
 const h=await retrievalHarness();try{
  for(const [mode,branches] of [['naive',['chunks']],['local',['entities']],['global',['relations']],['hybrid',['entities','relations']],['mix',['entities','relations','chunks']]] as const){
   const response=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'How does Alpha cooperate?',mode,cosineThreshold:-1}});
   expect(response.statusCode,response.body).toBe(200);const result=QueryDataSchema.parse(response.json());expect(result.diagnostics.branches).toEqual(branches);
   expect(result.chunks.length).toBeGreaterThan(0);expect(result.entities.length>0).toBe(mode!=='naive');
   if(mode==='naive')expect(result.diagnostics.keywords).toEqual({high:[],low:[],cached:false});
   else expect(result.diagnostics.keywords.cached).toBe(mode!=='local');
  }
  expect(h.model.requests.some(r=>Boolean((r.body as {documents?:unknown}).documents))).toBe(false);
 }finally{await h.close();}
});
it('mix retains independent document-vector hits when both graph branches miss the cosine threshold',async()=>{
 const {queryHandler}=await import('../helpers/retrieval.js');
 const h=await retrievalHarness((request,response)=>{
  const body=request.body as {input?:string[]};
  if(body.input)response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({data:body.input.map((s,index)=>({index,embedding:['Alpha','collaboration'].includes(s)?[-1,0]:[1,0]}))}));
  else queryHandler(request,response);
 });try{
  for(const mode of ['hybrid','mix']){const r=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'original question',mode,cosineThreshold:0.9}});expect(r.statusCode,r.body).toBe(200);const d=QueryDataSchema.parse(r.json());expect(d.entities).toEqual([]);expect(d.relationships).toEqual([]);expect(d.chunks.length).toBe(mode==='mix'?1:0);}
 }finally{await h.close();}
});
