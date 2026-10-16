import {expect,it} from 'vitest';
import {join} from 'node:path';
import {readdir,rm,readFile,rename,symlink} from 'node:fs/promises';
import {temporaryDirectory} from '../helpers/temporary-directory.js';
import {controlledDocuments} from '../helpers/controlled-documents.js';
import {startFakeModel} from '../helpers/fake-model.js';
import {kgHandler,indexingHarness} from '../helpers/indexing.js';
import {textProfile,embeddingProfile,bindings} from '../helpers/model-profiles.js';
import {importText,waitJob} from '../helpers/document-service.js';
import {startService} from '../helpers/owned-service.js';
import {maintain} from '../helpers/maintenance.js';
import {JobSchema} from '@tslightrag/contracts';
it.each(['before-maintenance-final','after-maintenance-final'] as const)('recovers SIGKILL at %s with one whole index and durable file-release records',async(point)=>{
  const dir=await temporaryDirectory();const model=await startFakeModel(kgHandler);const first=await controlledDocuments(dir.path,point);let next:Awaited<ReturnType<typeof startService>>|undefined;
  try{
    expect((await fetch(`${first.address}/api/v1/settings/models`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:0,profiles:[textProfile(model.url),embeddingProfile(model.url)],bindings:{...bindings,rerank:null}})})).status).toBe(200);
    const {result}=await importText(first.address,'first document');expect((await waitJob(first.address,result.job.id)).status).toBe('processed');
    const state=await(await fetch(`${first.address}/api/v1/maintenance`)).json() as {corpusRevision:number};
    const response=await fetch(`${first.address}/api/v1/documents/${result.document.id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedCorpusRevision:state.corpusRevision,expectedConfigRevision:1,expectedDocumentVersion:1})});expect(response.status).toBe(202);const job=JobSchema.parse(await response.json());await first.waitCheckpoint(job.id);await first.stop('SIGKILL');next=await startService(['--data-dir',dir.path]);
    const after=await waitJob(next.address,job.id);expect(after.status).toBe(point==='before-maintenance-final'?'interrupted':'processed');
    const listing=await(await fetch(`${next.address}/api/v1/documents`)).json() as {total:number};expect(listing.total).toBe(point==='before-maintenance-final'?1:0);
    const release=await(await fetch(`${next.address}/api/v1/maintenance`)).json() as {cleanupTasks:{status:string}[]};expect(release.cleanupTasks).toHaveLength(point==='before-maintenance-final'?0:1);
    expect((await readFile(join(dir.path,'documents',result.document.ingestion!.sourceKey))).length).toBeGreaterThan(0); // History still owns the original.
  }finally{if(next)await next.stop();await first.stop('SIGKILL');await model.stop();await dir.cleanup();}
});
it('retries file release after retained generations retire, and refuses symlink directories',async()=>{
  const h=await indexingHarness();try{const a=await h.import('first document');await h.wait(a.job.id);const job=await maintain(h,'delete',a.document.id);await h.wait(job.id);await expect.poll(()=>h.storage.capture().cleanupTasks[0]?.status,{timeout:10000}).toBe('retained');
    const generations=join(h.directory.path,'workspace/default/generations');const current=h.storage.capture().generation;
    // Only this synthetic temporary repository: explicitly retire historical snapshots for the cleanup scenario.
    for(const id of await readdir(generations))if(id!==current)await rm(join(generations,id),{recursive:true});
    const original=join(h.directory.path,'documents');await rename(original,join(h.directory.path,'held-documents'));await symlink(join(h.directory.path,'held-documents'),original);
    await h.app.inject({method:'POST',url:'/api/v1/maintenance/cleanup'});expect(h.storage.capture().cleanupTasks[0]?.status).toBe('failed');await rm(original);await rename(join(h.directory.path,'held-documents'),original);
    // Retire the extra metadata snapshots created by the failed attempt as well (they own no document).
    await h.app.inject({method:'POST',url:'/api/v1/maintenance/cleanup'});expect(h.storage.capture().cleanupTasks[0]?.status).toBe('done');await expect(readFile(join(original,a.document.ingestion!.sourceKey))).rejects.toHaveProperty('code','ENOENT');
  }finally{await h.close();}
});
it.each(['before-current','after-current'] as const)('maintains whole deletion state on %s write failure',async(point)=>{
  let armed=false;let fired=false;const h=await indexingHarness({documentOptions:{hook:async(p)=>{if(p==='before-maintenance-final')armed=true;}},storageHook:{hook:async(p)=>{if(armed&&!fired&&p===point){fired=true;throw new Error('disk-failure');}}}});
  try{const a=await h.import('first document');await h.wait(a.job.id);const old=h.storage.capture();const job=await maintain(h,'delete',a.document.id);await expect.poll(()=>fired,{timeout:10000}).toBe(true);
    if(point==='before-current'){expect((await h.wait(job.id)).status).toBe('failed');expect(h.storage.capture().document(a.document.id)).toEqual(old.document(a.document.id));expect(h.storage.capture().cleanupTasks).toEqual([]);}else expect(h.storage.healthy).toBe(false);
  }finally{armed=false;await h.close();}
});
