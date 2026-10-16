import { expect,it } from 'vitest';
import { indexingHarness,kgHandler } from '../helpers/indexing.js';
import { candidate,maintain } from '../helpers/maintenance.js';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { buildApp } from '../../apps/server/src/app.js';
it.each([{dimensions:3,model:'other-model'},{dimensions:2,model:'other-model'},{dimensions:2,operatorRevision:1}])('stages $model/$dimensions/$operatorRevision and atomically switches all namespaces with archived credentials',async(patch)=>{
  let dimensions=2;const h=await indexingHarness({handler:(req,res)=>{const input=(req.body as {input?:string[];model?:string}).input;if(input)res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({data:input.map((s,index)=>({index,embedding:Array.from({length:dimensions},(_,i)=>s.length+i+1)}))}));else kgHandler(req,res);}});
  try{const a=await h.import('first document');await h.wait(a.job.id);const old=h.storage.capture();const saved=await candidate(h,patch);expect(saved.activeIndex.spaceId).toBe(old.indexBinding!.spaceId);expect(saved.embeddingSpaceId).not.toBe(saved.activeIndex.spaceId);
    dimensions=patch.dimensions;const job=await maintain(h,'rebuild',undefined,{targetProfileId:'embedding'});expect((await h.wait(job.id)).status).toBe('processed');const view=h.storage.capture();expect(view.indexBinding?.spaceId).toBe(saved.embeddingSpaceId);expect(view.indexBinding?.configRevision).toBe(2);expect(view.corpusRevision).toBe(old.corpusRevision+1);
    for(const name of ['chunks','entities','relations']){const vectors=view.export()[`vectors-${name}.json` as 'vectors-chunks.json'] as {space:{id:string;dimensions:number};rows:{values:number[]}[]};expect(vectors.space).toMatchObject({id:saved.embeddingSpaceId,dimensions});expect(vectors.rows.every((r)=>r.values.length===dimensions)).toBe(true);}
    expect(old.indexBinding?.spaceId).not.toBe(view.indexBinding?.spaceId);expect(view.export()['graph.json']).toEqual(old.export()['graph.json']);
    await h.app.close();await h.storage.close();const reopened=await SnapshotStore.open(h.directory.path);const app=await buildApp({storage:reopened});try{expect((await app.inject({url:'/api/v1/settings/models'})).json().activeIndex.spaceId).toBe(saved.embeddingSpaceId);}finally{await app.close();await reopened.close();}
  }finally{await h.close();}
});
it('preserves old model/key and graph during failed staged batches; subsequent imports still use the old space',async()=>{
  let batch=0;let failing=false;const h=await indexingHarness({embeddingPatch:{apiKey:'active-index-key'},handler:(req,res)=>{const body=req.body as {input?:string[];model?:string};if(body.input&&body.model==='new-model'){batch++;if(failing&&batch===2){res.writeHead(500).end('failed');return;}}kgHandler(req,res);}});
  try{const a=await h.import('first document');await h.wait(a.job.id);const old=h.storage.capture();await candidate(h,{model:'new-model',batchSize:1,apiKey:'candidate-key'});failing=true;
    const job=await maintain(h,'rebuild',undefined,{targetProfileId:'embedding'});expect((await h.wait(job.id)).status).toBe('failed');expect(h.storage.capture().indexBinding).toEqual(old.indexBinding);expect(h.storage.capture().export()['vectors-chunks.json']).toEqual(old.export()['vectors-chunks.json']);
    const b=await h.import('second document');expect((await h.wait(b.job.id)).status).toBe('processed');const last=h.model.requests.filter((r)=>(r.body as {input?:unknown}).input).at(-1)!;expect(last.body).toHaveProperty('model','embedding-model');expect(last.headers.authorization).toBe('Bearer active-index-key');
    const settings=(await h.app.inject({url:'/api/v1/settings/models'})).json() as {revision:number;profiles:Record<string,unknown>[];bindings:Record<string,unknown>};
    const profiles=settings.profiles.filter((p)=>p.id!=='embedding').map((p)=>{const copy={...p};delete copy.hasApiKey;return copy;});
    expect((await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:settings.revision,profiles,bindings:{...settings.bindings,embedding:null}}})).statusCode).toBe(409);
  }finally{await h.close();}
});
it('candidate same-id credential changes do not replace the active version before activation, including restart',async()=>{
  const h=await indexingHarness();try{const a=await h.import('first document');await h.wait(a.job.id);await candidate(h,{model:'candidate',apiKey:'new-private-key'});const binding=h.storage.capture().indexBinding;
    await h.app.close();await h.storage.close();const reopened=await SnapshotStore.open(h.directory.path);const app=await buildApp({storage:reopened});try{const settings=(await app.inject({url:'/api/v1/settings/models'})).json() as {activeIndex:{profile:{model:string}}};expect(settings.activeIndex.profile.model).toBe('embedding-model');expect(reopened.capture().indexBinding).toEqual(binding);expect(JSON.stringify(settings)).not.toContain('new-private-key');}finally{await app.close();await reopened.close();}
  }finally{await h.close();}
});
