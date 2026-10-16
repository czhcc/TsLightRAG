import type { DocumentRecord } from '@tslightrag/contracts';
import { ModelClient } from '../models/client.js';
import { boundProfile, embeddingSpaceId } from '../models/config.js';
import type { ModelConfig, ModelConfigStore } from '../models/config.js';
import { ModelError } from '../models/errors.js';
import type { SnapshotStore } from '../storage/snapshot.js';
import type { WorkspaceDraft } from '../storage/state.js';
import { JsonSchema } from '../storage/kv.js';
import type { TextChunk } from '../core/chunker.js';
import { extract, LedgerSchema, EXTRACTION_VERSION, hash } from './extraction.js';
import { mergeContributions } from './merge.js';
import { summarizeDescriptions } from './summary.js';

export class Indexer {
  private tail: Promise<void> = Promise.resolve();
  private readonly client = new ModelClient();
  constructor(private readonly storage: SnapshotStore, private readonly configStore: ModelConfigStore) {}
  async prepare(chunks: TextChunk[], config: ModelConfig, signal: AbortSignal) {
    const profile = boundProfile(config, 'extract');
    if (profile?.kind !== 'text') throw new ModelError('MODEL_NOT_CONFIGURED', '未配置抽取文本模型', 409);
    const contributions = [];
    for (const chunk of chunks) {
      signal.throwIfAborted();
      const identity = { version: EXTRACTION_VERSION, contentHash: hash(chunk.content), configRevision: config.revision };
      // Revision scopes credentials and every model option without persisting a secret or its digest.
      const publicProfile = { ...profile }; delete publicProfile.apiKey;
      const key = `extract-${hash(JSON.stringify([identity, publicProfile, chunk.docVersion, chunk.chunkerVersion, chunk.tokenizer]))}`;
      const cached = this.storage.capture().getKV('caches', key);
      const ledger = cached === undefined ? { ...identity, contribution: await extract(this.client, profile, chunk.content, signal) } : LedgerSchema.parse(cached);
      if (cached === undefined) {
        signal.throwIfAborted();
        await this.storage.transact((draft) => { const bytes = Buffer.byteLength(JSON.stringify(ledger));
          const existing = draft.kv.caches.entries().reduce((n, [, v]) => n + Buffer.byteLength(JSON.stringify(v)), 0);
          if (bytes > 4 * 1024 * 1024 || existing + bytes > 128 * 1024 * 1024) throw new ModelError('EXTRACTION_CACHE_LIMIT', '抽取缓存达到本地容量限制');
          draft.kv.caches.set(key, JsonSchema.parse(ledger)); });
      }
      contributions.push({ chunkId: chunk.id, value: ledger.contribution, ledger });
    }
    return contributions;
  }
  /** Domain queue spans model calls, never SnapshotStore's write queue. Other job metadata remains writable. */
  publish(chunks: TextChunk[], doc: DocumentRecord, content: string, contributions: Awaited<ReturnType<Indexer['prepare']>>, config: ModelConfig,
    signal: AbortSignal, phase: (phase: 'embedding' | 'committing') => Promise<void>, finish: (draft: WorkspaceDraft) => void,
    guard: () => void) {
    const work = this.tail.then(async () => {
      signal.throwIfAborted(); guard();
      const base = this.storage.capture();
      const graph = base.export()['graph.json'] as ReturnType<WorkspaceDraft['graph']['serialize']>;
      const merged = mergeContributions(contributions, graph.nodes, graph.edges);
      const profile = boundProfile(config, 'extract'); const embedding = boundProfile(config, 'embedding');
      if (profile?.kind !== 'text' || embedding?.kind !== 'embedding') throw new ModelError('MODEL_NOT_CONFIGURED', '缺少抽取或向量模型', 409);
      for (const node of merged.nodes) if (merged.descriptions.has(node.id)) node.description = await summarizeDescriptions(this.client, profile, node.name, merged.descriptions.get(node.id)!, signal);
      for (const edge of merged.edges) if (merged.descriptions.has(edge.id)) edge.description = await summarizeDescriptions(this.client, profile, `${merged.nodes.find((n) => n.id === edge.sourceId)!.name} / ${merged.nodes.find((n) => n.id === edge.targetId)!.name}`, merged.descriptions.get(edge.id)!, signal);
      await phase('embedding');
      const inputs = [
        ...chunks.map((c) => ({ namespace: 'chunks' as const, id: c.id, content: c.content })),
        ...merged.nodes.filter((n) => merged.descriptions.has(n.id)).map((n) => ({ namespace: 'entities' as const, id: n.id, content: `${n.name}\n${n.type}\n${n.description}` })),
        ...merged.edges.filter((e) => merged.descriptions.has(e.id)).map((e) => ({ namespace: 'relations' as const, id: e.id, content: `${merged.nodes.find((n) => n.id === e.sourceId)!.name}\n${merged.nodes.find((n) => n.id === e.targetId)!.name}\n${e.keywords.join(', ')}\n${e.description}` })),
      ];
      const vectors = await this.client.embed(embedding, inputs.map((i) => i.content), signal);
      await phase('committing'); signal.throwIfAborted(); guard();
      await this.configStore.withRevision(config.revision, () => this.storage.transact((draft) => {
        signal.throwIfAborted(); guard();
        if (this.storage.capture().corpusRevision !== base.corpusRevision) throw new ModelError('INDEX_CONFLICT', '索引已改变，请重试文档', 409);
        finish(draft); // Status and all indexes are validated and published together.
        const spaceId = embeddingSpaceId(embedding)!;
        if (!draft.vectors.chunks.space || draft.vectors.chunks.space.id !== spaceId) draft.setEmbeddingSpace({ id: spaceId, dimensions: embedding.dimensions, normalization: 'l2' });
        for (const chunk of chunks) draft.kv.textChunks.set(chunk.id, { id: chunk.id, docId: doc.id, docVersion: doc.version, order: chunk.order,
          indexVersion: 's06-json-v1', content: chunk.content, tokens: chunk.tokens, location: JSON.stringify(chunk.locations) });
        draft.kv.fullDocs.set(doc.id, JsonSchema.parse({ ...draft.kv.fullDocs.get(doc.id) as object, content, chunkIds: chunks.map((c) => c.id) }));
        for (const c of contributions) draft.kv.extractions.set(c.chunkId, JsonSchema.parse(c.ledger));
        for (const n of merged.nodes) { draft.graph.setNode(n); draft.kv.entityChunks.set(n.id, n.sourceChunkIds); }
        for (const e of merged.edges) { draft.graph.setEdge(e); draft.kv.relationChunks.set(e.id, e.sourceChunkIds); }
        for (const [id, d] of draft.documents.entries()) if (d.status === 'processed') {
          const owned = new Set(draft.kv.textChunks.entries().filter(([, c]) => (c as {docId: string}).docId === id).map(([key]) => key));
          draft.kv.fullEntities.set(id, merged.nodes.filter((n) => n.sourceChunkIds.some((c) => owned.has(c))).map((n) => n.id).sort());
          draft.kv.fullRelations.set(id, merged.edges.filter((e) => e.sourceChunkIds.some((c) => owned.has(c))).map((e) => e.id).sort());
        }
        for (const [i, input] of inputs.entries()) draft.vectors[input.namespace].set({ id: input.id, values: vectors[i]!, contentHash: hash(input.content), metadata: { content: input.content } }, spaceId);
      }));
    });
    this.tail = work.then(() => {}, () => {}); return work;
  }
}
