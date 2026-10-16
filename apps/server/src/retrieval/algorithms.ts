// Ported from HKUDS/LightRAG@aaebfe1 operate.py / utils.py (MIT; see third_party/LightRAG/LICENSE).
import type { GraphNode, GraphEdge } from '../storage/graph.js';
import type { SnapshotView } from '../storage/snapshot.js';

export function roundRobin<T>(lists: readonly (readonly T[])[], key: (row:T)=>string): T[] {
  const result:T[]=[]; const seen=new Set<string>();
  for(let i=0;i<Math.max(0,...lists.map(l=>l.length));i++) for(const list of lists) {
    const row=list[i]; if(row!==undefined&&!seen.has(key(row))) { seen.add(key(row)); result.push(row); }
  }
  return result;
}
export function localRelations(view:SnapshotView, entities:GraphNode[]) {
  const edges = new Map<string,GraphEdge>();
  for(const node of entities) for(const neighbor of view.neighbors(node.id)) {
    const edge=view.edge(node.id,neighbor); if(edge&&!edges.has(edge.id)) edges.set(edge.id,edge);
  }
  const degrees=new Map<string,number>();
  const degree=(id:string)=>{let d=degrees.get(id);if(d===undefined){const n=view.neighbors(id);d=n.length+(n.includes(id)?1:0);degrees.set(id,d);}return d;};
  const rank=(e:GraphEdge)=>degree(e.sourceId)+degree(e.targetId);
  return [...edges.values()].sort((a,b)=>rank(b)-rank(a)||b.weight-a.weight);
}
/** Python canonical endpoint orientation uses entity names; persisted SHA IDs have a different lexical order. */
export function relationEndpoints(view:Pick<SnapshotView,'node'>,edge:GraphEdge):[string,string] {
  const pair:[string,string]=[edge.sourceId,edge.targetId];
  const a=[...(view.node(pair[0])?.name??pair[0])],b=[...(view.node(pair[1])?.name??pair[1])];
  let order=0;for(let i=0;i<Math.min(a.length,b.length);i++){order=a[i]!.codePointAt(0)!-b[i]!.codePointAt(0)!;if(order)break;}
  order ||= a.length-b.length;return order>0?[pair[1],pair[0]]:pair;
}
export function globalEntities(view:SnapshotView, relations:GraphEdge[]) {
  const ids=[...new Set(relations.flatMap(e=>relationEndpoints(view,e)))];
  return ids.flatMap(id=>{const n=view.node(id);return n?[n]:[];});
}
export function pythonRound(n:number) { const floor=Math.floor(n); return n-floor===0.5 ? (floor%2===0?floor:floor+1) : Math.round(n); }
export function weightedPolling(groups:readonly (readonly string[])[],max:number):string[] {
  if(!groups.length||max<=0) return [];
  if(groups.length===1) return groups[0]!.slice(0,max);
  const out:string[]=[]; const used:number[]=[]; let remaining=0;
  groups.forEach((group,i)=>{
    const expected=pythonRound(max-i/(groups.length-1)*(max-1)); const actual=Math.min(expected,group.length);
    out.push(...group.slice(0,actual));used.push(actual); remaining+=expected-actual;
  });
  for(let j=0;j<remaining;j++) { const i=groups.findIndex((g,k)=>used[k]!<g.length); if(i<0)break; out.push(groups[i]![used[i]!]!);used[i]!++; }
  return out;
}
export function sourceGroups(sources:readonly (readonly string[])[],excluded:readonly string[]=[]){
  const count=new Map<string,number>(); const skip=new Set(excluded);
  const groups=sources.map(ids=>ids.filter(id=>{
    if(skip.has(id))return false; const n=(count.get(id)??0)+1;count.set(id,n);return n===1;
  })).filter(g=>g.length);
  for(const group of groups)group.sort((a,b)=>count.get(b)!-count.get(a)!);
  return {groups,count};
}
export function vectorQuota(r:number,n:number){return r<=0||n<=0?0:Math.max(1,Math.floor(r*n/2));}
export function cosine(a:ArrayLike<number>,b:ArrayLike<number>){
  if(a.length!==b.length||!a.length)throw new Error('Vector dimension mismatch');
  let dot=0,an=0,bn=0;for(let i=0;i<a.length;i++){const x=a[i]!,y=b[i]!;if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('Invalid vector');dot+=x*y;an+=x*x;bn+=y*y;}
  if(!an||!bn)throw new Error('Zero vector');return dot/Math.sqrt(an*bn);
}
export function selectSources(sources:readonly (readonly string[])[], options:{method:'VECTOR'|'WEIGHT'; related:number; excluded?:readonly string[]; queryVector?:number[]; vector:(id:string)=>ArrayLike<number>|undefined; warnings:string[]}) {
  const {groups}=sourceGroups(sources,options.excluded);
  if(!groups.length||options.related<=0)return [];
  if(options.method==='WEIGHT')return weightedPolling(groups,options.related);
  // In upstream a missing query / vector store does not enter the VECTOR branch.
  if(!options.queryVector)return [];
  try {
    const ranked=groups.flat().map(id=>{const v=options.vector(id);if(!v)throw new Error('Missing source vector');return {id,score:cosine(options.queryVector!,v)};});
    ranked.sort((a,b)=>b.score-a.score); // stable first-appearance ties, not storage ID order
    if(ranked.length)return ranked.slice(0,vectorQuota(options.related,groups.length)).map(r=>r.id);
  }catch { /* Upstream explicitly falls back to weighted polling for inconsistent vectors. */ }
  options.warnings.push('关联块向量不可用，已回退 WEIGHT 来源块选择');
  return weightedPolling(groups,options.related);
}
