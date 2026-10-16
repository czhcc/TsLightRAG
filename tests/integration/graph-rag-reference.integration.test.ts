import {expect,it} from 'vitest';
import {reference,referenceView} from '../helpers/retrieval.js';
import {roundRobin,localRelations,globalEntities,selectSources} from '../../apps/server/src/retrieval/algorithms.js';
import {prefixBudget,contextJson,entityRecord,relationRecord} from '../../apps/server/src/retrieval/context.js';
for(const c of reference.cases)it(`upstream ${c.mode}/${c.method}/related=${String(c.related)} full search/source/merge functions`,()=>{
  const {view,graph}=referenceView();
  const local=c.mode==='global'?[]:['C','A','B'].map(n=>view.node(n)!);
  const global=c.mode==='local'?[]:[['D','D'],['A','C'],['A','B']].map(([a,b])=>view.edge(a!,b!)!);
  const entities=roundRobin([local,globalEntities(view,global)],n=>n.id),relations=roundRobin([localRelations(view,local),global],e=>e.id);
  expect(entities.map(n=>n.name)).toEqual(c.entities);
  expect(relations.map(e=>[e.sourceId,e.targetId])).toEqual(c.relations);
  const choose=(sources:string[][],excluded:string[]=[])=>selectSources(sources,{method:c.method,related:c.related,queryVector:[1,0],vector:id=>reference.vectors[id],excluded,warnings:[]});
  const ec=choose(entities.map(n=>n.sourceChunkIds)),rc=choose(relations.map(e=>e.sourceChunkIds),ec);
  expect(ec).toEqual(c.entityChunks);expect(rc).toEqual(c.relationChunks);
  expect(roundRobin([c.mode==='mix'?['outside','z','j']:[],ec,rc],s=>s)).toEqual(c.merged);
  expect(graph.degree('D')).toBe(3);
});
for(const c of reference.truncation)it(`upstream graph prefix truncation at ${String(c.limit)} codepoint tokens`,()=>{
  const {view}=referenceView();const local=['C','A','B'].map(n=>view.node(n)!);const global=[['D','D'],['A','C'],['A','B']].map(([a,b])=>view.edge(a!,b!)!);
  const entities=roundRobin([local,globalEntities(view,global)],n=>n.id),relations=roundRobin([localRelations(view,local),global],e=>e.id);
  const chars=(s:string)=>[...s].length;
  expect(prefixBudget(entities,c.limit,rows=>chars(rows.map(n=>contextJson(entityRecord(n))).join('\n'))).map(n=>n.name)).toEqual(c.entities);
  expect(prefixBudget(relations,c.limit,rows=>chars(rows.map(e=>contextJson(relationRecord(e,view))).join('\n'))).map(e=>[e.sourceId,e.targetId])).toEqual(c.relations);
});
it('matches upstream reference frequency/first-appearance ordering after explicit filename-to-document identity mapping',async()=>{
 const {buildContext}=await import('../../apps/server/src/retrieval/context.js');const {QuerySchema}=await import('@tslightrag/contracts');const {textProfile}=await import('../helpers/model-profiles.js');
 for(const c of reference.citations){
  const {view}=referenceView();view.document=(id:string)=>({id,name:id}) as ReturnType<typeof view.document>;
  const rows=c.chunks.map((row,i)=>({id:row.chunk_id,docId:row.file_path,docVersion:1,order:i,content:row.content,tokens:5,source:'vector' as const,referenceId:''}));
  const result=buildContext(view,QuerySchema.parse({query:'question'}),textProfile('http://127.0.0.1:12345'),[],[],rows);
  expect(result.references.map(r=>({reference_id:r.id,file_path:r.fileName}))).toEqual(c.references);
  expect(result.chunks.map(r=>r.referenceId)).toEqual(c.chunks.map(r=>r.reference_id));
 }
});
