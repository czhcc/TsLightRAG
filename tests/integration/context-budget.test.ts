import {expect,it} from 'vitest';
import {retrievalHarness} from '../helpers/retrieval.js';
import {QueryDataSchema} from '@tslightrag/contracts';
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
