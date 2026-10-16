import {expect,it} from 'vitest';
import {retrievalHarness} from '../helpers/retrieval.js';
import {QueryDataSchema} from '@tslightrag/contracts';
it('maps every rendered reference to captured document/version/chunk evidence, including original local parser positions',async()=>{
 const h=await retrievalHarness();try{
  const second=await h.import('second document for additional evidence');expect((await h.wait(second.job.id)).status).toBe('processed');
  const response=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',mode:'mix',cosineThreshold:-1}});expect(response.statusCode,response.body).toBe(200);
  const result=QueryDataSchema.parse(response.json());const view=h.storage.capture();
  for(const chunk of result.chunks){const ref=result.references.find(r=>r.id===chunk.referenceId)!;expect(ref.chunkIds).toContain(chunk.id);expect(ref.documentId).toBe(chunk.docId);expect(view.getKV('textChunks',chunk.id)).toMatchObject({docVersion:chunk.docVersion,content:chunk.content});expect(chunk.location).toBeTruthy();expect(result.context).toContain(chunk.content);}
  expect(result.references).toHaveLength(2);expect(new Set(result.references.map(r=>r.documentId)).size).toBe(2); // identical filenames must remain separate documents
  const empty=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',mode:'hybrid',maxEntityTokens:0,maxRelationTokens:0}});expect(empty.statusCode,empty.body).toBe(200);
  const boundary=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha?',mode:'naive',cosineThreshold:-1,maxTotalTokens:empty.json().diagnostics.budget.totalTokens as number}});
  expect(boundary.statusCode,boundary.body).toBe(200);const truncated=QueryDataSchema.parse(boundary.json());expect(truncated.chunks).toEqual([]);expect(truncated.references).toEqual([]);expect(truncated.diagnostics.truncated.chunks).toBe(2);

 }finally{await h.close();}
});
