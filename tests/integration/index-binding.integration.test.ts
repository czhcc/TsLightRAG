import {expect,it} from 'vitest';
import {readFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {temporaryDirectory} from '../helpers/temporary-directory.js';
import {SnapshotStore} from '../../apps/server/src/storage/snapshot.js';
import {ModelConfigStore,embeddingSpaceId} from '../../apps/server/src/models/config.js';
import {DocumentService} from '../../apps/server/src/documents/service.js';
import {startFakeModel} from '../helpers/fake-model.js';
import {kgHandler,indexingHarness} from '../helpers/indexing.js';
import {textProfile,embeddingProfile,bindings} from '../helpers/model-profiles.js';
import {candidate} from '../helpers/maintenance.js';
it('pairs a captured index reader with its exact immutable embedding profile even after activation and removal from candidate settings',async()=>{
  const dir=await temporaryDirectory();const model=await startFakeModel(kgHandler);const storage=await SnapshotStore.open(dir.path);const configs=await ModelConfigStore.open(dir.path,storage);const service=await DocumentService.open(storage,configs);
  const wait=async(id:string)=>{await expect.poll(()=>storage.capture().job(id)?.status,{timeout:12000}).toBe('processed');};
  try{
    const a=embeddingProfile(model.url,{apiKey:'old-active-key'});const text=textProfile(model.url);await configs.save({expectedRevision:0,profiles:[text,a],bindings:{...bindings,rerank:null}});const first=await service.importText({name:'first.txt',text:'first document'});await wait(first.job.id);const captured=configs.captureIndex();
    const b=embeddingProfile(model.url,{id:'embedding-next',model:'next-model',apiKey:'next-key'});await configs.save({expectedRevision:1,profiles:[text,a,b],bindings:{...bindings,embedding:b.id,rerank:null}});
    const job=await service.requestMaintenance('rebuild',null,{expectedCorpusRevision:storage.capture().corpusRevision,expectedConfigRevision:2,targetProfileId:b.id});await wait(job.id);const current=configs.captureIndex();expect(current.profile?.id).toBe(b.id);expect(captured.profile?.apiKey).toBe('old-active-key');expect(captured.view.indexBinding?.spaceId).toBe(embeddingSpaceId(captured.profile));
    await configs.save({expectedRevision:2,profiles:[text,b],bindings:{...bindings,embedding:b.id,rerank:null}});expect(configs.embeddingForSnapshot(captured.view)).toEqual(captured.profile);
    expect(captured.view.search('chunks',[1,0],{spaceId:embeddingSpaceId(captured.profile)!,topK:1})).toHaveLength(1);expect(()=>captured.view.search('chunks',[1,0],{spaceId:embeddingSpaceId(current.profile)!,topK:1})).toThrow('space');
    expect(await readFile(join(dir.path,'config/versions/1.json'),'utf8')).toContain('old-active-key');expect((await stat(join(dir.path,'config/versions/1.json'))).mode&0o777).toBe(0o600);
  }finally{await service.close();await configs.close();await storage.close();await model.stop();await dir.cleanup();}
});
it('fails closed on a missing active credential version without dropping the indexed corpus',async()=>{
  const h=await indexingHarness();try{const first=await h.import('first document');await h.wait(first.job.id);await candidate(h,{model:'candidate'});await h.app.close();await h.storage.close();await rm(join(h.directory.path,'config/versions/1.json'));
    const restored=await SnapshotStore.open(h.directory.path);try{await expect(ModelConfigStore.open(h.directory.path,restored)).rejects.toHaveProperty('code','CONFIG_REFERENCE_INVALID');expect(restored.capture().document(first.document.id)?.status).toBe('processed');}finally{await restored.close();}
  }finally{await h.close();}
});
