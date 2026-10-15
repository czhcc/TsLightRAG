import { DocumentSchema, JobSchema, IdSchema } from '@tslightrag/contracts';
import { z } from 'zod';
import { MemoryKV, JsonSchema } from './kv.js';
import { MemoryVectors } from './vectors.js';
import type { VectorSpace } from './vectors.js';
import { MemoryGraph } from './graph.js';

export const KV_NAMES = ['fullDocs', 'textChunks', 'extractions', 'fullEntities', 'fullRelations', 'entityChunks', 'relationChunks', 'caches'] as const;
export type KVName = typeof KV_NAMES[number];
export const VECTOR_NAMES = ['chunks', 'entities', 'relations'] as const;
export const FILE_NAMES = ['kv.json', 'document-status.json', 'vectors-chunks.json', 'vectors-entities.json', 'vectors-relations.json', 'graph.json'] as const;
export type FileName = typeof FILE_NAMES[number];
export type Files = Record<FileName, unknown>;
const rows = z.array(z.tuple([IdSchema, JsonSchema]));
const KvFileSchema = z.strictObject({
  fullDocs: rows, textChunks: rows, extractions: rows, fullEntities: rows,
  fullRelations: rows, entityChunks: rows, relationChunks: rows, caches: rows,
});
export const StoredDocumentSchema = DocumentSchema.extend({ content: z.string().optional() });
export const ChunkSchema = z.strictObject({
  id: IdSchema, docId: IdSchema, docVersion: z.number().int().positive(),
  order: z.number().int().nonnegative(), content: z.string().min(1), tokens: z.number().int().positive(),
  location: z.string().optional(),
});
const StatusFileSchema = z.strictObject({
  documents: z.array(z.tuple([IdSchema, DocumentSchema])), jobs: z.array(z.tuple([IdSchema, JobSchema])),
});
type Document = z.infer<typeof DocumentSchema>;
type Job = z.infer<typeof JobSchema>;

function sameKeys(actual: string[], expected: string[], label: string) {
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Invalid ${label} references`);
  }
}
function add(map: Map<string, Set<string>>, id: string, value: string) {
  const values = map.get(id) ?? new Set<string>(); values.add(value); map.set(id, values);
}
function checkIndex(kv: MemoryKV, expected: Map<string, Set<string>>, name: string) {
  sameKeys(kv.entries().map(([id]) => id), [...expected.keys()], name);
  for (const [id, values] of expected) sameKeys(z.array(IdSchema).parse(kv.get(id)), [...values], name);
}

/** A candidate is mutable; only SnapshotStore can publish it. */
export class WorkspaceDraft {
  kv = Object.fromEntries(KV_NAMES.map((name) => [name, new MemoryKV()])) as Record<KVName, MemoryKV>;
  documents = new MemoryKV<Document>((value) => DocumentSchema.parse(value));
  jobs = new MemoryKV<Job>((value) => JobSchema.parse(value));
  vectors = { chunks: new MemoryVectors(), entities: new MemoryVectors(), relations: new MemoryVectors() };
  graph = new MemoryGraph();
  setEmbeddingSpace(space: VectorSpace) {
    if (VECTOR_NAMES.some((name) => this.vectors[name].size)) throw new Error('Rebuild required before changing embedding space');
    for (const name of VECTOR_NAMES) this.vectors[name] = new MemoryVectors(space);
  }
  serialize(): Files {
    return {
      'kv.json': Object.fromEntries(KV_NAMES.map((name) => [name, this.kv[name].entries()])),
      'document-status.json': { documents: this.documents.entries(), jobs: this.jobs.entries() },
      'vectors-chunks.json': this.vectors.chunks.serialize(), 'vectors-entities.json': this.vectors.entities.serialize(),
      'vectors-relations.json': this.vectors.relations.serialize(), 'graph.json': this.graph.serialize(),
    };
  }
  static restore(files: Files) {
    const draft = new WorkspaceDraft();
    const kv = KvFileSchema.parse(files['kv.json']);
    for (const name of KV_NAMES) draft.kv[name] = MemoryKV.restore(kv[name], (value) => JsonSchema.parse(value));
    const statuses = StatusFileSchema.parse(files['document-status.json']);
    draft.documents = MemoryKV.restore(statuses.documents, (value) => DocumentSchema.parse(value));
    draft.jobs = MemoryKV.restore(statuses.jobs, (value) => JobSchema.parse(value));
    for (const name of VECTOR_NAMES) draft.vectors[name] = MemoryVectors.restore(files[`vectors-${name}.json`]);
    draft.graph = MemoryGraph.restore(files['graph.json']);
    draft.validate(); return draft;
  }
  validate() {
    const docs = new Map(this.kv.fullDocs.entries().map(([id, value]) => {
      const doc = StoredDocumentSchema.parse(value);
      if (doc.id !== id) throw new Error('Document identity mismatch');
      return [id, doc];
    }));
    sameKeys(this.documents.entries().map(([id]) => id), [...docs.keys()], 'document status');
    for (const [id, doc] of docs) {
      const status = this.documents.get(id);
      const metadata = { ...doc }; delete metadata.content;
      if (JSON.stringify(status) !== JSON.stringify(DocumentSchema.parse(metadata))) throw new Error('Document status mismatch');
    }
    for (const [id, job] of this.jobs.entries()) {
      if (job.id !== id || (job.documentId !== null && !docs.has(job.documentId))) throw new Error('Job document reference mismatch');
    }
    for (const doc of docs.values()) if (doc.ingestion) {
      const job = this.jobs.get(doc.ingestion.latestJobId);
      if (doc.ingestion.sourceKey !== `${doc.contentHash}.blob` || !job || job.documentId !== doc.id || job.status !== doc.status) throw new Error('Ingestion job/source reference mismatch');
    }
    for (const job of this.jobs.entries().map(([, value]) => value)) {
      if (job.previousJobId) { const previous = this.jobs.get(job.previousJobId);
        if (!previous || previous.documentId !== job.documentId || previous.attempt + 1 !== job.attempt) throw new Error('Job attempt chain mismatch'); }
      if (job.result && job.result.artifactKey !== `${job.id}/prepared.json`) throw new Error('Job artifact identity mismatch');
    }
    const chunks = new Map(this.kv.textChunks.entries().map(([id, value]) => {
      const chunk = ChunkSchema.parse(value); const doc = docs.get(chunk.docId);
      if (chunk.id !== id || !doc || doc.version !== chunk.docVersion || doc.status !== 'processed') throw new Error('Chunk document reference mismatch');
      return [id, chunk];
    }));
    const docEntities = new Map<string, Set<string>>(); const docRelations = new Map<string, Set<string>>();
    for (const [id, doc] of docs) {
      if (doc.status === 'processed') {
        if (![...chunks.values()].some((chunk) => chunk.docId === id)) throw new Error('Processed document has no chunks');
        docEntities.set(id, new Set()); docRelations.set(id, new Set());
      }
    }
    for (const [id] of this.kv.extractions.entries()) if (!chunks.has(id)) throw new Error('Extraction chunk missing');
    const graph = this.graph.serialize();
    const entityChunks = new Map<string, Set<string>>(); const relationChunks = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
      entityChunks.set(node.id, new Set(node.sourceChunkIds));
      for (const id of node.sourceChunkIds) {
        const chunk = chunks.get(id); if (!chunk) throw new Error('Graph source chunk missing');
        add(docEntities, chunk.docId, node.id);
      }
    }
    for (const edge of graph.edges) {
      relationChunks.set(edge.id, new Set(edge.sourceChunkIds));
      for (const id of edge.sourceChunkIds) {
        const chunk = chunks.get(id); if (!chunk) throw new Error('Graph source chunk missing');
        add(docRelations, chunk.docId, edge.id);
      }
    }
    checkIndex(this.kv.fullEntities, docEntities, 'fullEntities'); checkIndex(this.kv.fullRelations, docRelations, 'fullRelations');
    checkIndex(this.kv.entityChunks, entityChunks, 'entityChunks'); checkIndex(this.kv.relationChunks, relationChunks, 'relationChunks');
    sameKeys(this.vectors.chunks.serialize().rows.map((row) => row.id), [...chunks.keys()], 'chunk vectors');
    sameKeys(this.vectors.entities.serialize().rows.map((row) => row.id), graph.nodes.map((node) => node.id), 'entity vectors');
    sameKeys(this.vectors.relations.serialize().rows.map((row) => row.id), graph.edges.map((edge) => edge.id), 'relation vectors');
    const spaces = VECTOR_NAMES.map((name) => JSON.stringify(this.vectors[name].space));
    if (new Set(spaces).size !== 1) throw new Error('Mixed embedding spaces');
  }
}
