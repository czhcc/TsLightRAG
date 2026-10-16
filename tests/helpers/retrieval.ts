import { readFileSync } from 'node:fs';
import type { ModelRequest } from './fake-model.js';
import type { ServerResponse } from 'node:http';
import { kgHandler, reply, indexingHarness } from './indexing.js';
import { MemoryGraph } from '../../apps/server/src/storage/graph.js';
import type { SnapshotView } from '../../apps/server/src/storage/snapshot.js';
export const reference=JSON.parse(readFileSync(new URL('../fixtures/graph/s08-python-reference.json',import.meta.url),'utf8')) as {
  upstream:string;nodes:Record<string,{entity_type:string;description:string;source_id:string}>;
  edges:{source:string;target:string;weight:number;description:string;source_id:string}[];
  vectors:Record<string,number[]>;
  cases:{mode:string;method:'VECTOR'|'WEIGHT';related:number;entities:string[];relations:string[][];entityChunks:string[];relationChunks:string[];merged:string[]}[];
  selection:{missing:boolean;method:'VECTOR'|'WEIGHT';expected:string[]}[];
  polling:{groups:string[][];related:number;expected:string[]}[];
  truncation:{limit:number;entities:string[];relations:string[][]}[];
  fallback:{query:string;content:string}[];
  normalized:{input:unknown;expected:string[]}[];
  processing:{limit:number;chunks:string[];references:{reference_id:string;file_path:string}[]}[];
  citations:{chunks:{chunk_id:string;content:string;file_path:string;reference_id:string}[];references:{reference_id:string;file_path:string}[]}[];
  vectorContent:{entity:string;relation:string;chunk:string};
};
export function referenceView(){
  const graph=new MemoryGraph();
  for(const [name,n]of Object.entries(reference.nodes))graph.setNode({id:name,name,type:n.entity_type,description:n.description,sourceChunkIds:n.source_id.split('<SEP>')});
  for(const e of reference.edges)graph.setEdge({sourceId:e.source,targetId:e.target,description:e.description,keywords:[],weight:e.weight,sourceChunkIds:e.source_id.split('<SEP>')});
  const view={node:(id:string)=>graph.getNode(id),edge:(a:string,b:string)=>graph.getEdge(a,b),neighbors:(id:string)=>graph.neighbors(id)} as SnapshotView;
  return {view,graph};
}
export function queryHandler(request:ModelRequest,response:ServerResponse){
  const body=request.body as {messages?:{content:string}[]};
  if(body.messages?.some(m=>m.content.includes('expert keyword extractor')))reply(response,{high_level_keywords:['collaboration'],low_level_keywords:['Alpha']});else kgHandler(request,response);
}
export async function retrievalHarness(handler=queryHandler){
  const h=await indexingHarness({handler});const doc=await h.import('first document for retrieval');const job=await h.wait(doc.job.id);
  if(job.status!=='processed')throw new Error(JSON.stringify(job));return h;
}
