import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ModelClient } from '../../apps/server/src/models/client.js';
import { extract, parseExtraction } from '../../apps/server/src/indexing/extraction.js';
import { mergeContributions } from '../../apps/server/src/indexing/merge.js';
import { summarizeDescriptions } from '../../apps/server/src/indexing/summary.js';
import { countTokens } from '../../apps/server/src/core/tokenizer.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { textProfile } from '../helpers/model-profiles.js';
import { indexingHarness, kgHandler, reply, empty } from '../helpers/indexing.js';
import { generationHarness, isGeneration, generationPost } from '../helpers/generation.js';
import { maintain } from '../helpers/maintenance.js';
import type { Extraction } from '../../apps/server/src/indexing/extraction.js';
import type { SnapshotView } from '../../apps/server/src/storage/snapshot.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/graph/s11-input.json', import.meta.url), 'utf8')) as {
  extraction: { name: string; rounds: Extraction[] }[];
  documents: { chunkId: string; content: string; raw: Extraction }[];
  summaries: { name: string; descriptions: string[] }[];
  summaryModelOutput: string; naiveChunk: { id: string; content: string; fileName: string };
};
type Normalized = { nodes: { name: string; type: string; descriptions: string[]; sources: string[] }[];
  edges: { source: string; target: string; descriptions: string[]; sources: string[]; keywords: string[]; weight: number }[] };
const reference = JSON.parse(readFileSync(new URL('../fixtures/graph/s11-python-reference.json', import.meta.url), 'utf8')) as {
  upstream: string; executedFunctions: string[];
  naive: { empty: boolean; query: string; history: { role: 'user'; content: string }[]; calls: {query:string;system:string;history:unknown[]}[]; raw: {data:{chunks:{content:string}[];references:{reference_id:string;file_path:string}[]}} | null; response: string | null }[];
  extraction: { name: string; result: unknown; modelCalls: number }[];
  summaries: { name: string; description: string; modelCalls: number; inputTokens: number }[];
  merged: Normalized; deletion: { removed: string; graph: Normalized }[];
};
const alphabetical = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
function normalizeExtraction(result: Extraction) {
  return { entities: result.entities.toSorted(alphabetical), relationships: result.relationships.map(row => ({ ...row, keywords: row.keywords.split(',').map(s => s.trim()).sort() })).sort((a,b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)) };
}
function normalizeGraph(graph: ReturnType<typeof mergeContributions>, source = (id: string) => id): Normalized {
  const names = new Map(graph.nodes.map(n => [n.id,n.name]));
  return {
    nodes: graph.nodes.map(n => ({ name:n.name,type:n.type,descriptions:n.description.split('<SEP>').sort(),sources:n.sourceChunkIds.map(source).sort() })).sort(alphabetical),
    edges: graph.edges.map(e => { const [a,b] = [names.get(e.sourceId)!,names.get(e.targetId)!].sort(); return { source:a!,target:b!,descriptions:e.description.split('<SEP>').sort(),sources:e.sourceChunkIds.map(source).sort(),keywords:e.keywords.toSorted(),weight:e.weight }; }).sort((a,b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
  };
}
it('records execution of full pinned extraction, merge, summary and rebuild entrypoints', () => {
  expect(reference.upstream).toBe('aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a');
  for (const name of ['extract_entities','_merge_nodes_then_upsert','_merge_edges_then_upsert','_handle_entity_relation_summary','rebuild_knowledge_from_chunks','_get_cached_extraction_results','_rebuild_from_extraction_result','_rebuild_single_entity','_rebuild_single_relationship']) expect(reference.executedFunctions).toContain(`operate.py::${name}`);
});
for (const c of fixture.extraction) it(`G01 full pinned extraction/gleaning: ${c.name}`, async () => {
  let index = 0;
  const model = await startFakeModel((_request,response) => reply(response,c.rounds[index++]));
  try {
    const actual = await extract(new ModelClient(),textProfile(model.url),'Alpha and Beta evidence',new AbortController().signal);
    const expected = reference.extraction.find(r => r.name===c.name)!;
    expect(normalizeExtraction(actual)).toEqual(expected.result); expect(model.requests).toHaveLength(expected.modelCalls);
  } finally { await model.stop(); }
});
for (const c of fixture.summaries) it(`G02 full pinned summary selection and shared BPE: ${c.name}`, async () => {
  const model = await startFakeModel((_request,response) => reply(response,fixture.summaryModelOutput));
  try {
    const expected = reference.summaries.find(r=>r.name===c.name)!;
    expect(c.descriptions.reduce((sum,s)=>sum+countTokens(s,'cl100k_base'),0)).toBe(expected.inputTokens);
    const result = await summarizeDescriptions(new ModelClient(),textProfile(model.url),'Alpha',c.descriptions,new AbortController().signal);
    expect(result).toBe(expected.description); expect(model.requests).toHaveLength(expected.modelCalls);
  } finally { await model.stop(); }
});
it('G02 full pinned merge matches names/types/source sets/descriptions/keywords/weights and excludes duplicate retry weight', () => {
  const contributions = fixture.documents.map(d=>({chunkId:d.chunkId,value:parseExtraction(JSON.stringify(d.raw))}));
  const merged = mergeContributions(contributions,[],[]);
  expect(normalizeGraph(merged)).toEqual(reference.merged);
  const retried = mergeContributions([contributions[0]!],merged.nodes,merged.edges);
  expect(normalizeGraph(retried)).toEqual(reference.merged);
});
for (const removed of ['A','B']) it(`G11 actual deletion of ${removed} matches full pinned rebuild, vectors and new query sources`, async () => {
  const h = await indexingHarness({handler:(request,response)=>{
    const body=request.body as { input?: unknown; messages?: {role:string;content:string}[] };
    if (body.input) { kgHandler(request,response); return; }
    if (body.messages?.[0]?.content.includes('expert keyword extractor')) {reply(response,{high_level_keywords:['research'],low_level_keywords:['Alpha']});return;}
    if (body.messages?.some(m=>m.role==='assistant')) { reply(response,empty); return; }
    reply(response,fixture.documents[body.messages?.some(m=>m.content.includes('second document'))?1:0]!.raw);
  }});
  try {
    const documents = new Map<string,string>();
    for (const d of fixture.documents) {const result=await h.import(d.content); expect((await h.wait(result.job.id)).status).toBe('processed'); documents.set(d.chunkId,result.document.id);}
    const source = (view: SnapshotView, id: string) => {
      const chunk=view.getKV('textChunks',id) as {docId:string}; return [...documents].find(([,doc])=>doc===chunk.docId)![0];
    };
    const normalize = (view: SnapshotView) => normalizeGraph({...view.export()['graph.json'] as Pick<ReturnType<typeof mergeContributions>,'nodes'|'edges'>,descriptions:new Map()},id=>source(view,id));
    expect(normalize(h.storage.capture())).toEqual(reference.merged);
    const job=await maintain(h,'delete',documents.get(removed)!);expect((await h.wait(job.id)).status).toBe('processed');
    const view=h.storage.capture();const expected=reference.deletion.find(r=>r.removed===removed)!;
    expect(normalize(view)).toEqual(expected.graph);
    for (const namespace of ['entities','relations','chunks'] as const) {
      const file=view.export()[`vectors-${namespace}.json`] as {rows:{id:string;values:number[];metadata:{content:string}}[]};
      expect(file.rows.length).toBe(namespace==='chunks'?1:namespace==='entities'?expected.graph.nodes.length:expected.graph.edges.length);
      for (const row of file.rows) { expect(Math.hypot(...row.values)).toBeCloseTo(1,5); expect(row.metadata.content).not.toContain(`from ${removed}.`); }
    }
    const response=await h.app.inject({method:'POST',url:'/api/v1/query/data',payload:{query:'Alpha cooperation?',mode:'mix'}});
    expect(response.statusCode).toBe(200);
    const result=response.json() as { chunks:{docId:string}[]; references:{documentId:string}[] };
    expect(result.chunks).toHaveLength(1);expect(result.references).toHaveLength(1);
    expect(result.references[0]!.documentId).not.toBe(documents.get(removed));
  } finally { await h.close(); }
});

for (const c of reference.naive) it(`G12 full pinned naive generation/context handoff, empty=${String(c.empty)}`, async () => {
  expect(reference.executedFunctions).toContain('operate.py::naive_query');
  expect(c.calls).toHaveLength(c.empty ? 0 : 1);
  if (c.empty) expect(c.response).toBeNull();
  else expect(c.calls[0]!.system).toContain(fixture.naiveChunk.content);
  if (!c.empty) { expect(c.calls[0]!.system).toContain(`[1] ${fixture.naiveChunk.fileName}`); expect(c.calls[0]!.history).toEqual(c.history); }
  const h = await generationHarness();
  try {
    if (c.empty) { const job = await maintain(h,'clear'); expect((await h.wait(job.id)).status).toBe('processed'); }
    const calls = h.model.requests.filter(isGeneration).length;
    const response = await generationPost(h,'/api/v1/query',{query:c.query,mode:'naive',conversationHistory:c.history});
    expect(response.status).toBe(200);
    const body = await response.json() as {data:{context:string;chunks:{content:string}[]};references:{id:string;fileName:string}[]};
    if (c.empty) { expect(h.model.requests.filter(isGeneration)).toHaveLength(calls); expect((body as unknown as {status:string}).status).toBe('empty'); return; }
    const actual = h.model.requests.filter(isGeneration).at(-1)!.body as {messages:{role:string;content:string}[]};
    expect(actual.messages[0]!.content).toContain(body.data.context);
    expect(actual.messages.slice(1,-1)).toEqual(c.history);
    expect(actual.messages.at(-1)!.content).toBe(c.calls[0]!.query);
    expect(body.data.chunks.map(r=>r.content)).toEqual(c.raw!.data.chunks.map(r=>r.content));
    expect(body.references.map(r=>({reference_id:r.id,file_path:r.fileName}))).toEqual(c.raw!.data.references);
  } finally { await h.close(); }
});
