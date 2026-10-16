import {expect,it} from 'vitest';
import {temporaryDirectory} from '../helpers/temporary-directory.js';
import {controlledDocuments} from '../helpers/controlled-documents.js';
import {startFakeModel} from '../helpers/fake-model.js';
import {kgHandler} from '../helpers/indexing.js';
import {textProfile,embeddingProfile,bindings} from '../helpers/model-profiles.js';
import {importText,waitJob} from '../helpers/document-service.js';
import {startService} from '../helpers/owned-service.js';
import {JobSchema} from '@tslightrag/contracts';
it.each(['before-maintenance-final','after-maintenance-final'] as const)('restarts a killed vector switch at %s with a single matching model binding',async(point)=>{
  const dir=await temporaryDirectory();const model=await startFakeModel(kgHandler);const first=await controlledDocuments(dir.path,point);let next:Awaited<ReturnType<typeof startService>>|undefined;
  try{const put=async(revision:number,operatorRevision:number)=>{const r=await fetch(`${first.address}/api/v1/settings/models`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision,profiles:[textProfile(model.url),embeddingProfile(model.url,{operatorRevision})],bindings:{...bindings,rerank:null}})});expect(r.status).toBe(200);return r.json() as Promise<{embeddingSpaceId:string}>;};
    const old=await put(0,0);const {result}=await importText(first.address,'first document');expect((await waitJob(first.address,result.job.id)).status).toBe('processed');const candidate=await put(1,1);const state=await(await fetch(`${first.address}/api/v1/maintenance`)).json() as {corpusRevision:number};
    const response=await fetch(`${first.address}/api/v1/maintenance/rebuild`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedCorpusRevision:state.corpusRevision,expectedConfigRevision:2,targetProfileId:'embedding'})});expect(response.status).toBe(202);const job=JobSchema.parse(await response.json());await first.waitCheckpoint(job.id);const calls=model.requests.length;await first.stop('SIGKILL');next=await startService(['--data-dir',dir.path]);
    expect((await waitJob(next.address,job.id)).status).toBe(point==='before-maintenance-final'?'interrupted':'processed');const config=await(await fetch(`${next.address}/api/v1/settings/models`)).json() as {activeIndex:{spaceId:string}};expect(config.activeIndex.spaceId).toBe(point==='before-maintenance-final'?old.embeddingSpaceId:candidate.embeddingSpaceId);expect(model.requests).toHaveLength(calls);
  }finally{if(next)await next.stop();await first.stop('SIGKILL');await model.stop();await dir.cleanup();}
});
