import {expect,it} from 'vitest';
import {retrievalHarness} from '../helpers/retrieval.js';
import {QueryDataSchema,QueryResponseSchema} from '@tslightrag/contracts';
import {generationHarness,generationPost,collect,isGeneration} from '../helpers/generation.js';
import {textProfile,embeddingProfile,bindings} from '../helpers/model-profiles.js';
it('uses the saved model context for previews and answers with a 26384-token output reserve',async()=>{
 const h=await generationHarness();try{
  const save=await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:1,
   profiles:[textProfile(h.model.url,{maxOutputTokens:26384,contextTokens:32768}),embeddingProfile(h.model.url)],bindings:{...bindings,rerank:null}}});
  expect(save.statusCode,save.body).toBe(200);
  for(const maxTotalTokens of [undefined,50000]){
   const res=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',maxTotalTokens}});
   expect(res.statusCode,res.body).toBe(200);
   const data=QueryDataSchema.parse(res.json());
   expect(data.diagnostics.budget).toMatchObject({limit:32768,reservedOutputTokens:26384});
   expect(data.diagnostics.budget.totalTokens).toBeLessThanOrEqual(32768);expect(data.chunks.length).toBeGreaterThan(0);
  }
  const answer=await h.app.inject({method:'POST',url:'/api/v1/query',payload:{query:'Alpha?'}});
  expect(answer.statusCode,answer.body).toBe(200);expect(QueryResponseSchema.parse(answer.json()).answer).toContain('[1]');
  expect(h.model.requests.filter(isGeneration)[0]?.body).toMatchObject({max_tokens:26384});
  const stream=await generationPost(h,'/api/v1/query/stream',{query:'How does Alpha cooperate?'});
  expect(stream.status).toBe(200);const frames=await collect(stream);
  expect(frames.some(e=>e.type==='error')).toBe(false);expect(frames.some(e=>e.type==='done')).toBe(true);
  const before=h.model.requests.length;
  for(const extra of [{maxTotalTokens:16000},{conversationHistory:[{role:'user',content:'x '.repeat(9000)}]}]){
   const bad=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',...extra}});
   expect(bad.statusCode).toBe(400);expect(bad.json().code).toBe('QUERY_BUDGET_EXCEEDED');
   expect(bad.json().message).toContain('回答预留 26384');expect(bad.json().message).toContain('总预算');
  }
  expect(h.model.requests.length).toBe(before);
 }finally{await h.close();}
});
it('charges history, custom instructions, rendered references and output reserve; fails before HTTP for impossible budgets',async()=>{
 const h=await retrievalHarness();try{
  const requests=h.model.requests.length;
  const bad=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',maxTotalTokens:100}});expect(bad.statusCode).toBe(400);expect(bad.json().code).toBe('QUERY_BUDGET_EXCEEDED');expect(h.model.requests.length).toBe(requests);
  const call=async(extra:Record<string,unknown>)=>{const res=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',...extra}});expect(res.statusCode,res.body).toBe(200);return QueryDataSchema.parse(res.json());};
  const base=await call({});const history=await call({conversationHistory:[{role:'user',content:'previous context '.repeat(20)}],userPrompt:'Answer in Chinese.'});
  expect(history.prompt).toContain('previous context');expect(history.prompt).toContain('Answer in Chinese.');expect(history.diagnostics.budget.inputTokens).toBeGreaterThan(base.diagnostics.budget.inputTokens);
  expect(history.diagnostics.budget.totalTokens).toBe(history.diagnostics.budget.inputTokens+history.diagnostics.budget.reservedOutputTokens);expect(history.diagnostics.budget.totalTokens).toBeLessThanOrEqual(history.diagnostics.budget.limit);
  const zero=await call({mode:'hybrid',maxEntityTokens:0,maxRelationTokens:0});expect(zero.entities).toEqual([]);expect(zero.relationships).toEqual([]);expect(zero.diagnostics.selectedEntityChunks).toEqual([]);expect(zero.diagnostics.selectedRelationChunks).toEqual([]);expect(zero.status).toBe('empty');
  const graph=await call({mode:'hybrid',relatedChunkNumber:0});expect(graph.entities.length).toBeGreaterThan(0);expect(graph.chunks).toEqual([]);
 }finally{await h.close();}
});
