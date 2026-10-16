import { expect,it } from 'vitest';
import { indexingHarness } from '../helpers/indexing.js';
import { maintain } from '../helpers/maintenance.js';
it.each(['delete','clear'] as const)('%s last document removes every graph/vector/anchor/cache and releases active binding atomically',async(op)=>{
  const h=await indexingHarness();try{const a=await h.import('first document');await h.wait(a.job.id);const before=h.storage.capture();const calls=h.model.requests.length;
    const job=await maintain(h,op,op==='delete'?a.document.id:undefined);expect((await h.wait(job.id)).status).toBe('processed');const view=h.storage.capture();
    expect(view.documents()).toEqual([]);for(const name of ['textChunks','extractions','fullEntities','fullRelations','entityChunks','relationChunks','caches'] as const)expect(view.entries(name)).toEqual([]);
    expect(view.export()['graph.json']).toEqual({nodes:[],edges:[]});for(const name of ['chunks','entities','relations'])expect(view.export()[`vectors-${name}.json` as 'vectors-chunks.json']).toEqual({space:null,rows:[]});
    expect(view.indexBinding).toBeUndefined();expect(view.corpusRevision).toBe(before.corpusRevision+1);expect(h.model.requests).toHaveLength(calls);expect(view.jobs().every((j)=>j.documentId===null)).toBe(true);
    await expect.poll(()=>h.storage.capture().cleanupTasks[0]?.status,{timeout:10000}).toBe('retained');
  }finally{await h.close();}
});
