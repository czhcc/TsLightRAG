import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { indexingHarness, kgHandler, reply, kg, empty } from '../helpers/indexing.js';
import { entityId } from '../../apps/server/src/indexing/extraction.js';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
it('indexes concurrent documents with exact shared graph, original contributions and three vector namespaces; survives reload', async () => {
  const h = await indexingHarness();
  try {
    const [a,b] = await Promise.all([h.import('first document Alpha Beta'), h.import('second document Alpha Beta Gamma')]);
    const jobs = await Promise.all([h.wait(a.job.id),h.wait(b.job.id)]); expect(jobs.map((j) => j.status)).toEqual(['processed','processed']);
    const view = h.storage.capture(); const files = view.export();
    const graph = files['graph.json'] as {nodes: unknown[]; edges: {weight: number; sourceChunkIds: string[];description: string}[]};
    expect(graph.nodes).toHaveLength(3); expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map((e) => e.weight).sort()).toEqual([1,5]);
    expect(graph.edges.find((e) => e.weight === 5)?.description).toBe('Alpha and Beta cooperate.');
    expect(view.node(entityId('Alpha'))?.sourceChunkIds).toHaveLength(2);
    expect(view.entries('extractions')).toHaveLength(2); expect(view.entries('caches')).toHaveLength(2);
    expect(view.getKV('fullEntities',a.document.id)).toHaveLength(2); expect(view.getKV('fullEntities',b.document.id)).toHaveLength(3);
    expect(view.getKV('fullRelations',a.document.id)).toHaveLength(1); expect(view.getKV('fullRelations',b.document.id)).toHaveLength(2);
    for (const [namespace,count] of [['chunks',2],['entities',3],['relations',2]] as const) {
      const vectors = files[`vectors-${namespace}.json`] as {space: {id: string};rows: {contentHash: string;values:number[]}[]};
      expect(vectors.rows).toHaveLength(count); expect(vectors.space.id).toMatch(/^[a-f0-9]{64}$/);
      for (const row of vectors.rows) { expect(row.contentHash).toMatch(/^[a-f0-9]{64}$/); expect(Math.hypot(...row.values)).toBeCloseTo(1,5); }
    }
    await mkdir(new URL('../../.tools/', import.meta.url), { recursive: true });
    await writeFile(new URL('../../.tools/s06-index-intermediates.json', import.meta.url), JSON.stringify({ graph, extractions: view.entries('extractions'), anchors: { fullEntities: view.entries('fullEntities'), fullRelations: view.entries('fullRelations'), entityChunks: view.entries('entityChunks'), relationChunks: view.entries('relationChunks') }, vectors: {chunks:files['vectors-chunks.json'],entities:files['vectors-entities.json'],relations:files['vectors-relations.json']} }, null, 2));
    const requests = h.model.requests.length; const duplicate = await h.import('first document Alpha Beta');
    expect(duplicate.deduplicated).toBe(true); expect(duplicate.job.id).toBe(a.job.id); expect(h.model.requests).toHaveLength(requests);
    await h.app.close(); await h.storage.close(); const reopened = await SnapshotStore.open(h.directory.path);
    try { expect(reopened.capture().export()).toEqual(files); } finally { await reopened.close(); }
  } finally { await h.close(); }
});
it('does not publish any business index while embedding is pending or after embedding failure', async () => {
  let release: (() => void) | undefined; let reached = false;
  const h = await indexingHarness({ handler: (req,res) => {
    if ((req.body as {input?:unknown}).input) { reached = true; release = () => { if (!res.writableEnded) res.writeHead(500).end('private-body'); }; }
    else kgHandler(req,res);
  } });
  try {
    const a = await h.import('first document'); await expect.poll(() => reached, {timeout: 10000}).toBe(true);
    expect(h.storage.capture().entries('textChunks')).toEqual([]); expect(h.storage.capture().node(entityId('Alpha'))).toBeUndefined();
    expect(h.storage.capture().job(a.job.id)?.status).toBe('embedding'); release!();
    const failed = await h.wait(a.job.id); expect(failed.status).toBe('failed'); expect(failed.error).not.toContain('private-body');
    expect(h.storage.capture().entries('textChunks')).toEqual([]); expect(h.storage.capture().corpusRevision).toBe(0);
    expect(h.storage.capture().entries('caches')).toHaveLength(1); expect(failed.result?.chunks).toBe(1);
  } finally { release?.(); await h.close(); }
});
it.each(['before-current', 'after-current'] as const)('keeps full-document atomicity on %s disk failure', async (point) => {
  let armed = false; let fired = false;
  const h = await indexingHarness({ documentOptions: { hook: async (phase) => { if (phase === 'before-index-final') armed = true; } },
    storageHook: { hook: async (phase) => { if (armed && !fired && phase === point) { fired = true; throw new Error('disk-failure'); } } } });
  try {
    const a = await h.import('first document'); await expect.poll(() => fired, {timeout: 10000}).toBe(true);
    if (point === 'before-current') {
      expect((await h.wait(a.job.id)).status).toBe('failed'); expect(h.storage.capture().entries('textChunks')).toEqual([]);
      expect(h.storage.capture().corpusRevision).toBe(0);
    } else expect(h.storage.healthy).toBe(false);
    armed = false; await h.app.close(); await h.storage.close();
    const reopened = await SnapshotStore.open(h.directory.path);
    try {
      const v = reopened.capture(); expect(v.document(a.document.id)?.status).toBe(point === 'after-current' ? 'processed' : 'failed');
      expect(v.entries('textChunks')).toHaveLength(point === 'after-current' ? 1 : 0);
      expect(v.node(entityId('Alpha')) !== undefined).toBe(point === 'after-current');
    } finally { await reopened.close(); }
  } finally { armed = false; await h.close(); }
});
it('summarizes long merged descriptions and keeps raw per-source descriptions', async () => {
  let summaries = 0;
  const h = await indexingHarness({ handler: (req,res) => {
    const body = req.body as {input?: unknown; messages: {role:string; content:string}[]};
    if (body.input) { kgHandler(req,res); return; }
    if (body.messages[0]?.content.includes('Description List:')) { summaries++; reply(res,'Alpha combines research evidence.'); return; }
    if (body.messages.some((m) => m.role === 'assistant')) { reply(res,empty); return; }
    const v = kg(); v.entities[0]!.description = ('Detailed evidence about Alpha. '.repeat(130)) + (body.messages.some((m) => m.content.includes('second document')) ? 'Second.' : 'First.'); reply(res,v);
  } });
  try {
    const a = await h.import('first document'); expect((await h.wait(a.job.id)).status).toBe('processed');
    const b = await h.import('second document'); expect((await h.wait(b.job.id)).status).toBe('processed');
    expect(summaries).toBe(1); expect(h.storage.capture().node(entityId('Alpha'))?.description).toBe('Alpha combines research evidence.');
    expect(JSON.stringify(h.storage.capture().entries('extractions'))).toContain('Detailed evidence');
  } finally { await h.close(); }
});
it('merges multiple overlapping chunks of one document with complete source anchors', async () => {
  const h = await indexingHarness();
  try {
    const a = await h.import(Array.from({length:500},(_,i)=>`Alpha and Beta research record ${String(i)}.`).join('\n'));
    const job = await h.wait(a.job.id); expect(job.status).toBe('processed'); const count = job.result!.chunks; expect(count).toBeGreaterThan(1);
    const view = h.storage.capture(); expect(view.entries('textChunks')).toHaveLength(count); expect(view.entries('extractions')).toHaveLength(count);
    expect(view.node(entityId('Alpha'))?.sourceChunkIds).toHaveLength(count);
    const graph = view.export()['graph.json'] as {edges:{weight:number;sourceChunkIds:string[]}[]};
    expect(graph.edges).toHaveLength(1); expect(graph.edges[0]?.weight).toBe(count*2); expect(graph.edges[0]?.sourceChunkIds).toHaveLength(count);
  } finally {await h.close();}
});
it('accepts a valid empty extraction as a chunk-only index with empty graph anchors', async () => {
  const h = await indexingHarness({handler:(req,res)=>{if((req.body as {input?:unknown}).input) kgHandler(req,res); else reply(res,empty);}});
  try {
    const a=await h.import('No named entities.'); expect((await h.wait(a.job.id)).status).toBe('processed');
    expect(h.storage.capture().getKV('fullEntities',a.document.id)).toEqual([]); expect(h.storage.capture().getKV('fullRelations',a.document.id)).toEqual([]);
    expect(h.storage.capture().entries('textChunks')).toHaveLength(1); expect(h.storage.capture().export()['graph.json']).toEqual({nodes:[],edges:[]});
  } finally {await h.close();}
});
