import {JsonSchema} from '../../apps/server/src/storage/kv.js';
import { expect,it } from 'vitest';
import { indexingHarness,kgHandler } from '../helpers/indexing.js';
import { maintain } from '../helpers/maintenance.js';
import { buildApp } from '../../apps/server/src/app.js';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
it('replaces a document version and raw source without adding weights; old artifacts survive restart validation',async()=>{
  const h=await indexingHarness();try{const a=await h.import('first document');await h.wait(a.job.id);const b=await h.import('second document');await h.wait(b.job.id);const old=h.storage.capture();
    const job=await maintain(h,'reindex',a.document.id,{replacement:{name:'new.txt',text:'first document revised evidence'}});expect((await h.wait(job.id)).status).toBe('processed');
    const current=h.storage.capture();expect(current.document(a.document.id)).toMatchObject({id:a.document.id,version:2,status:'processed',name:'new.txt'});expect(current.document(b.document.id)).toEqual(old.document(b.document.id));
    const graph=current.export()['graph.json'] as {edges:{weight:number}[]};expect(graph.edges.map((e)=>e.weight).sort()).toEqual([1,5]);expect(current.entries('textChunks')).toHaveLength(2);
    expect(current.entries('textChunks').filter(([,v])=>(v as {docId:string;docVersion:number}).docId===a.document.id).every(([,v])=>(v as {docVersion:number}).docVersion===2)).toBe(true);
    await h.app.close();await h.storage.close();const reopened=await SnapshotStore.open(h.directory.path);const app=await buildApp({storage:reopened});try{expect((await app.inject({url:`/api/v1/documents/${a.document.id}/parsed`})).json()).toHaveProperty('text','first document revised evidence');}finally{await app.close();await reopened.close();}
  }finally{await h.close();}
});
it('failed/cancelled reindex keeps the complete old version visible and supports idempotent manual retry',async()=>{
  let fail=false;const h=await indexingHarness({handler:(req,res)=>{if(fail&&(req.body as {input?:unknown}).input)res.writeHead(500).end('failed');else kgHandler(req,res);}});
  try{const a=await h.import('first document');await h.wait(a.job.id);const before=h.storage.capture();fail=true;
    const job=await maintain(h,'reindex',a.document.id);expect((await h.wait(job.id)).status).toBe('failed');expect(h.storage.capture().document(a.document.id)).toEqual(before.document(a.document.id));expect(h.storage.capture().export()['graph.json']).toEqual(before.export()['graph.json']);expect(h.storage.capture().corpusRevision).toBe(before.corpusRevision);
    fail=false;const retry=()=>h.app.inject({method:'POST',url:`/api/v1/documents/${a.document.id}/retry`,payload:{expectedJobId:job.id}});const [r1,r2]=await Promise.all([retry(),retry()]);expect(r1.statusCode).toBe(202);expect(r1.json().job.id).toBe(r2.json().job.id);expect((await h.wait(r1.json().job.id as string)).status).toBe('processed');expect(h.storage.capture().document(a.document.id)?.version).toBe(2);
  }finally{await h.close();}
});
it('cancel or competing corpus update before the maintenance commit preserves the published document',async()=>{
  let entered=false;let release:()=>void=()=>{};const h=await indexingHarness({documentOptions:{hook:async(point,_job,signal)=>{if(point==='before-maintenance-final'){entered=true;await new Promise<void>((r)=>{release=r;signal.addEventListener('abort',()=>{r();},{once:true});});}}}});
  try{const a=await h.import('first document');await h.wait(a.job.id);const before=h.storage.capture();const job=await maintain(h,'reindex',a.document.id);
    await expect.poll(()=>entered,{timeout:10000}).toBe(true);expect(h.storage.capture().document(a.document.id)).toEqual(before.document(a.document.id));await h.app.inject({method:'POST',url:`/api/v1/jobs/${job.id}/cancel`});release();expect((await h.wait(job.id)).status).toBe('cancelled');expect(h.storage.capture().corpusRevision).toBe(before.corpusRevision);
  }finally{release();await h.close();}
});
it('allows another document to commit during maintenance computation, rejects the stale candidate, then retries on the newer corpus',async()=>{
  let entered=false;let release:()=>void=()=>{};const h=await indexingHarness({documentOptions:{hook:async(point)=>{if(point==='before-maintenance-final'&&!entered){entered=true;await new Promise<void>((r)=>{release=r;});}}}});
  try{const a=await h.import('first document');await h.wait(a.job.id);const job=await maintain(h,'reindex',a.document.id);await expect.poll(()=>entered,{timeout:10000}).toBe(true);const b=await h.import('second document');expect((await h.wait(b.job.id)).status).toBe('processed');release();expect((await h.wait(job.id)).errorCode).toBe('INDEX_CONFLICT');expect(h.storage.capture().document(a.document.id)?.version).toBe(1);
    const next=await maintain(h,'reindex',a.document.id);expect((await h.wait(next.id)).status).toBe('processed');expect(h.storage.capture().document(a.document.id)?.version).toBe(2);expect(h.storage.capture().document(b.document.id)?.version).toBe(1);const graph=h.storage.capture().export()['graph.json'] as {nodes:unknown[];edges:{weight:number}[]};expect(graph.nodes).toHaveLength(3);expect(graph.edges.map((e)=>e.weight).sort()).toEqual([1,5]);
  }finally{release();await h.close();}
});
it('rejects a stale computed candidate after a corpus change without overwriting the newer state',async()=>{
  let entered=false;let release:()=>void=()=>{};const h=await indexingHarness({documentOptions:{hook:async(point)=>{if(point==='before-maintenance-final'){entered=true;await new Promise<void>((r)=>{release=r;});}}}});
  try{const a=await h.import('first document');await h.wait(a.job.id);const job=await maintain(h,'reindex',a.document.id);await expect.poll(()=>entered,{timeout:10000}).toBe(true);
    await h.storage.transact((draft)=>{const doc=draft.documents.get(a.document.id)!;const updated={...doc,name:'newer.txt'};draft.documents.set(doc.id,updated);draft.kv.fullDocs.set(doc.id,JsonSchema.parse({...draft.kv.fullDocs.get(doc.id) as object,...updated}));});release();expect((await h.wait(job.id)).errorCode).toBe('INDEX_CONFLICT');expect(h.storage.capture().document(a.document.id)).toMatchObject({version:1,name:'newer.txt',status:'processed'});
  }finally{release();await h.close();}
});
it('surfaces a replacement parser failure without changing the published version',async()=>{
  const h=await indexingHarness();try{const a=await h.import('first document');await h.wait(a.job.id);const before=h.storage.capture();const job=await maintain(h,'reindex',a.document.id,{replacement:{name:'bad.txt',text:'\u0000invalid'}});expect((await h.wait(job.id)).errorCode).toBe('INVALID_CONTENT');expect(h.storage.capture().document(a.document.id)).toEqual(before.document(a.document.id));expect(h.storage.capture().corpusRevision).toBe(before.corpusRevision);}finally{await h.close();}
});
