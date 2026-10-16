import { expect,it } from 'vitest';
import { indexingHarness,kgHandler,kg,empty,reply } from '../helpers/indexing.js';
import { maintain } from '../helpers/maintenance.js';
import { entityId } from '../../apps/server/src/indexing/extraction.js';
it.each(['first','second'])('deletes %s contribution and reconstructs shared graph/descriptions/vectors solely from survivors',async(which)=>{
  const h=await indexingHarness({handler:(req,res)=>{const body=req.body as {input?:unknown;messages:{role:string;content:string}[]};if(body.input){kgHandler(req,res);return;}if(body.messages.some((m)=>m.role==='assistant')){reply(res,empty);return;}const second=body.messages.some((m)=>m.content.includes('second document'));const value=kg(second);value.entities[0]!.description=second?'Alpha surviving B facts.':'Alpha deleted A facts.';reply(res,value);}});
  try{
    const a=await h.import('first document');expect((await h.wait(a.job.id)).status).toBe('processed');const b=await h.import('second document');expect((await h.wait(b.job.id)).status).toBe('processed');
    const before=h.storage.capture();const remove=which==='first'?a:b;const survivor=which==='first'?b:a;
    const job=await maintain(h,'delete',remove.document.id);expect((await h.wait(job.id)).status).toBe('processed');
    const view=h.storage.capture();expect(view.document(remove.document.id)).toBeUndefined();expect(view.document(survivor.document.id)?.status).toBe('processed');expect(view.corpusRevision).toBe(before.corpusRevision+1);
    const graph=view.export()['graph.json'] as {nodes:unknown[];edges:{weight:number}[]};expect(graph.nodes).toHaveLength(which==='first'?3:2);expect(graph.edges.map((e)=>e.weight).sort()).toEqual(which==='first'?[1,3]:[2]);
    expect(view.node(entityId('Alpha'))).toMatchObject({description:which==='first'?'Alpha surviving B facts.':'Alpha deleted A facts.'});expect(view.node(entityId('Alpha'))?.sourceChunkIds).toHaveLength(1);
    const removed=before.entries('textChunks').filter(([,v])=>(v as {docId:string}).docId===remove.document.id).map(([id])=>id);
    for(const id of removed){expect(view.getKV('textChunks',id)).toBeUndefined();expect(view.getKV('extractions',id)).toBeUndefined();}
    expect(view.entries('caches')).toEqual([]);expect(JSON.stringify(view.export()['vectors-entities.json'])).not.toContain(which==='first'?'deleted A':'surviving B');
    expect(before.document(remove.document.id)?.status).toBe('processed'); // A captured reader remains coherent.
  }finally{await h.close();}
});
it('rejects stale maintenance admissions and duplicate content replacement',async()=>{
  const h=await indexingHarness();try{const a=await h.import('first document');await h.wait(a.job.id);const b=await h.import('second document');await h.wait(b.job.id);
    expect((await h.app.inject({method:'DELETE',url:`/api/v1/documents/${a.document.id}`,payload:{expectedCorpusRevision:0,expectedConfigRevision:1,expectedDocumentVersion:1}})).statusCode).toBe(409);
    expect((await h.app.inject({method:'POST',url:`/api/v1/documents/${a.document.id}/reindex`,payload:{expectedCorpusRevision:h.storage.capture().corpusRevision,expectedConfigRevision:1,expectedDocumentVersion:1,replacement:{name:'copy.txt',text:'second document'}}})).statusCode).toBe(409);
  }finally{await h.close();}
});
