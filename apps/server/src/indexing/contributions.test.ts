import { expect, it } from 'vitest';
import { indexingHarness } from '../../../../tests/helpers/indexing.js';
import { JsonSchema } from '../storage/kv.js';
import { WorkspaceDraft } from '../storage/state.js';
it('persists bidirectional chunk/entity/relation anchors and rejects missing or untracked contributions', async () => {
  const h = await indexingHarness();
  try {
    const a = await h.import('first document'); expect((await h.wait(a.job.id)).status).toBe('processed');
    const files = h.storage.capture().export(); const draft = WorkspaceDraft.restore(files);
    const [chunkId] = draft.kv.textChunks.entries()[0]!;
    expect((draft.kv.fullDocs.get(a.document.id) as {chunkIds:string[]}).chunkIds).toEqual([chunkId]);
    for (const node of draft.graph.serialize().nodes) expect(draft.kv.entityChunks.get(node.id)).toEqual([chunkId]);
    for (const edge of draft.graph.serialize().edges) expect(draft.kv.relationChunks.get(edge.id)).toEqual([chunkId]);
    draft.kv.extractions.delete(chunkId); expect(() => draft.validate()).toThrow('extraction missing');
    const d2 = WorkspaceDraft.restore(files); const ledger = d2.kv.extractions.get(chunkId) as {contribution: {entities: unknown[]}};
    ledger.contribution.entities = []; d2.kv.extractions.set(chunkId, JsonSchema.parse(ledger)); expect(() => d2.validate()).toThrow('anchor');
    const d3 = WorkspaceDraft.restore(files); d3.kv.fullEntities.set(a.document.id, []); expect(() => d3.validate()).toThrow('fullEntities');
    const d4 = WorkspaceDraft.restore(files); d4.kv.fullDocs.set(a.document.id, { ...d4.kv.fullDocs.get(a.document.id) as object, chunkIds: [] }); expect(() => d4.validate()).toThrow('document chunks');
  } finally { await h.close(); }
});
