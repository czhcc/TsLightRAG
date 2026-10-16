import {expect,it} from 'vitest';
import {retrievalHarness,reference} from '../helpers/retrieval.js';
import {entityId} from '../../apps/server/src/indexing/extraction.js';
import {edgeId} from '../../apps/server/src/storage/graph.js';
it('maps all three source-content fields and canonical IDs to one validated normalized space without silently rewriting S06 index content',async()=>{
 const h=await retrievalHarness();try{
  const view=h.storage.capture();const graph=view.export()['graph.json'] as {nodes:{id:string;name:string;type:string;description:string}[];edges:{id:string;sourceId:string;targetId:string;description:string;keywords:string[]}[]};
  const binding=view.indexBinding!;
  for(const ns of ['chunks','entities','relations'] as const){const file=view.export()[`vectors-${ns}.json`] as {space:{id:string;dimensions:number;normalization:string};rows:{id:string;values:number[];metadata:{content:string}}[]};expect(file.space).toEqual({id:binding.spaceId,dimensions:2,normalization:'l2'});
   for(const row of file.rows){expect(Math.hypot(...row.values)).toBeCloseTo(1,5);expect(view.getVector(ns,row.id)).toBeTruthy();
    if(ns==='chunks')expect(view.getKV('textChunks',row.id)).toMatchObject({content:row.metadata.content});
    if(ns==='entities'){const node=graph.nodes.find(n=>n.id===row.id)!;expect(node.id).toBe(entityId(node.name));const fields=row.metadata.content.split('\n');expect(fields[0]).toBe(node.name);expect(fields[1]).toBe(node.type);expect(fields.slice(2).join('\n')).toBe(node.description);}
    if(ns==='relations'){const edge=graph.edges.find(e=>e.id===row.id)!;expect(edge.id).toBe(edgeId(edge.sourceId,edge.targetId));expect(edge.id).toBe(edgeId(edge.targetId,edge.sourceId));expect(row.metadata.content).toContain(graph.nodes.find(n=>n.id===edge.sourceId)!.name);expect(row.metadata.content).toContain(graph.nodes.find(n=>n.id===edge.targetId)!.name);expect(row.metadata.content).toContain(edge.keywords.join(', '));expect(row.metadata.content).toContain(edge.description);}
   }
  }
  // Independent upstream original f-string execution documents the intentionally retained S06 formatting adapter.
  expect(reference.vectorContent).toMatchObject({entity:'Alpha\nEvidence',relation:'research, collaboration\tAlpha\nBeta\nEvidence'});
  expect(()=>view.search('chunks',[1,0,0],{spaceId:binding.spaceId,topK:1})).toThrow('dimension');expect(()=>view.search('entities',[1,0],{spaceId:'wrong',topK:1})).toThrow('space');
 }finally{await h.close();}
});
