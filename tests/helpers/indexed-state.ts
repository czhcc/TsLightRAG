import type { WorkspaceDraft } from '../../apps/server/src/storage/state.js';

export function indexFixture(draft: WorkspaceDraft) {
  const doc = { id: 'doc-1', name: 'old', contentHash: 'a'.repeat(64), version: 1,
    status: 'processed' as const, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' };
  draft.kv.fullDocs.set(doc.id, { ...doc, content: '本地文件，中文 🧮' }); draft.documents.set(doc.id, doc);
  draft.kv.textChunks.set('c1', { id: 'c1', docId: doc.id, docVersion: 1, order: 0, content: '本地文件，中文 🧮', tokens: 8 });
  for (const id of ['e1', 'e2']) {
    draft.graph.setNode({ id, name: id, type: 'concept', description: 'old', sourceChunkIds: ['c1'] });
    draft.kv.entityChunks.set(id, ['c1']);
  }
  const relation = draft.graph.setEdge({ sourceId: 'e1', targetId: 'e2', description: 'old', keywords: ['关系'], weight: 1, sourceChunkIds: ['c1'] });
  draft.kv.fullEntities.set(doc.id, ['e1', 'e2']); draft.kv.fullRelations.set(doc.id, [relation]);
  draft.kv.relationChunks.set(relation, ['c1']); draft.kv.extractions.set('c1', { entities: ['e1', 'e2'], relations: [relation] });
  draft.jobs.set('job-1', { id: 'job-1', documentId: doc.id, operation: 'index', status: 'processed',
    attempt: 1, configRevision: 0, cancelRequested: false, error: null, updatedAt: doc.updatedAt });
  draft.setEmbeddingSpace({ id: 'space-v1', dimensions: 2, normalization: 'l2' });
  const row = (id: string, values: number[]) => ({ id, values, contentHash: 'a'.repeat(64), metadata: { marker: 'old' } });
  draft.vectors.chunks.set(row('c1', [1, 0]), 'space-v1');
  draft.vectors.entities.set(row('e1', [1, 0]), 'space-v1'); draft.vectors.entities.set(row('e2', [0, 1]), 'space-v1');
  draft.vectors.relations.set(row(relation, [1, 1]), 'space-v1');
  draft.kv.caches.set('marker', 'old');
}
