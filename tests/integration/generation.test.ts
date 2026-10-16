import {expect,it} from 'vitest';
import {QueryResponseSchema} from '@tslightrag/contracts';
import {generationHarness,generationHandler,isGeneration} from '../helpers/generation.js';
import {reply} from '../helpers/indexing.js';
import {maintain} from '../helpers/maintenance.js';
it('sends the exact final budgeted system/context/history/query and returns only existing evidence citations',async()=>{
 const h=await generationHarness();try{
  const r=await h.app.inject({method:'POST',url:'/api/v1/query',payload:{query:'Alpha 如何协作？',conversationHistory:[{role:'user',content:'先前问题'},{role:'assistant',content:'先前回答'}],userPrompt:'使用中文回答'}});
  expect(r.statusCode,r.body).toBe(200);const data=QueryResponseSchema.parse(r.json());expect(data.answer).toContain('[1]');expect(data.references).toHaveLength(1);expect(data.cached).toBe(false);
  const requests=h.model.requests.filter(isGeneration);expect(requests).toHaveLength(1);const messages=(requests[0]!.body as {messages:{role:string;content:string}[]}).messages;
  expect(messages[0]!.content).toContain(data.data.context);expect(messages[0]!.content).toContain('使用中文回答');expect(messages.slice(1)).toEqual([{role:'user',content:'先前问题'},{role:'assistant',content:'先前回答'},{role:'user',content:'Alpha 如何协作？'}]);
  expect(data.data.diagnostics.budget.totalTokens).toBeLessThanOrEqual(data.data.diagnostics.budget.limit);
 }finally{await h.close();}
});
it('returns context/prompt previews and empty evidence without calling the answer model',async()=>{
 const h=await generationHarness();try{
  for(const flags of [{onlyNeedContext:true},{onlyNeedPrompt:true}]){const r=await h.app.inject({method:'POST',url:'/api/v1/query',payload:{query:'Alpha?',...flags}});expect(r.statusCode,r.body).toBe(200);const data=QueryResponseSchema.parse(r.json());expect(data.status).toBe('preview');expect(data.answer).toBe(flags.onlyNeedPrompt?data.data.prompt:data.data.context);}
  const clear=await maintain(h,'clear');await h.wait(clear.id);
  const r=await h.app.inject({method:'POST',url:'/api/v1/query',payload:{query:'Alpha?'}});expect(r.statusCode,r.body).toBe(200);const result=QueryResponseSchema.parse(r.json());expect(result.status).toBe('empty');expect(result.answer).toContain('未找到');expect(result.references).toEqual([]);expect(h.model.requests.filter(isGeneration)).toHaveLength(0);
 }finally{await h.close();}
});
it('warns about nonexistent numeric references without fabricating sources and does not cache a truncated answer',async()=>{
 let finish='stop';const h=await generationHarness((request,response)=>{if(isGeneration(request))reply(response,'未知引用 [999]，现有引用 [1]。',finish);else generationHandler(request,response);});try{
  const call=()=>h.app.inject({method:'POST',url:'/api/v1/query',payload:{query:'Alpha?'}});
  const first=await call();expect(first.statusCode,first.body).toBe(200);const data=QueryResponseSchema.parse(first.json());expect(data.warnings.join()).toContain('999');expect(data.references.map(r=>r.id)).toEqual(['1']);
  finish='length';const second=await call();expect(second.statusCode,second.body).toBe(200);expect(second.json().finishReason).toBe('length');expect(second.json().warnings.join()).toContain('输出上限');await call();expect(h.model.requests.filter(isGeneration)).toHaveLength(3);
 }finally{await h.close();}
});
