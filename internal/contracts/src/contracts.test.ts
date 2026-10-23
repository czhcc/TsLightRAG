import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema, CitationSchema, DocumentSchema, EntitySchema, JobSchema,
  ModelProfileSchema, ModelSettingsSchema, QuerySchema, RelationSchema, StreamEventSchema,
} from './index.js';

const profile = {
  id: 'text-1', kind: 'text', protocol: 'openai-compatible', name: '本地文本',
  endpoint: 'http://127.0.0.1:8888/v1', model: 'local-text', timeoutMs: 30_000,
  maxConcurrency: 2, hasApiKey: false,
};
const document = {
  id: 'doc-1', name: '研究.md', contentHash: 'a'.repeat(64), version: 1,
  status: 'queued', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
};
describe('query contracts', () => {
  it('uses mix and the upstream VECTOR/5 defaults', () => {
    expect(QuerySchema.parse({ query: ' 知识图谱是什么？ ' })).toMatchObject({
      query: '知识图谱是什么？', mode: 'mix', kgChunkPickMethod: 'VECTOR', relatedChunkNumber: 5,
    });
  });
  it('leaves the total budget to the model unless explicitly supplied', () => {
    expect(QuerySchema.parse({ query: 'question' }).maxTotalTokens).toBeUndefined();
    expect(QuerySchema.parse({ query: 'question', maxTotalTokens: 16000 }).maxTotalTokens).toBe(16000);
  });
  it.each(['naive', 'local', 'global', 'hybrid', 'mix'])('accepts %s mode', (mode) => {
    expect(QuerySchema.parse({ query: 'question', mode }).mode).toBe(mode);
  });
  it.each([
    {}, { query: ' ' }, { query: 'x'.repeat(20_001) }, { query: 'x', mode: 'bypass' },
    { query: 'x', topK: 0 }, { query: 'x', topK: 1.5 }, { query: 'x', maxTotalTokens: Infinity },
    { query: 'x', kgChunkPickMethod: 'RRF' }, { query: 'x', relatedChunkNumber: -1 },
    { query: 'x', conversationHistory: [{ role: 'system', content: 'untrusted' }] },
    { query: 'x', onlyNeedContext: true, onlyNeedPrompt: true }, { query: 'x', unexpected: true },
  ])('rejects malformed or oversized query %#', (input) => {
    expect(QuerySchema.safeParse(input).success).toBe(false);
  });
});
describe('model contracts', () => {
  it('accepts local HTTP profiles', () => { expect(ModelProfileSchema.parse(profile).id).toBe('text-1'); });
  it.each(['ftp://host', 'https://user:secret@host/v1', 'https://host/v1?key=x', 'https://host/#x'])('rejects unsafe URL %s', (endpoint) => {
    expect(ModelProfileSchema.safeParse({ ...profile, endpoint }).success).toBe(false);
  });
  it('rejects API keys in public configuration', () => {
    expect(ModelProfileSchema.safeParse({ ...profile, apiKey: 'fixture-secret' }).success).toBe(false);
  });
  it('requires dimensions and finite concurrency', () => {
    expect(ModelProfileSchema.safeParse({ ...profile, kind: 'embedding' }).success).toBe(false);
    expect(ModelProfileSchema.safeParse({ ...profile, maxConcurrency: NaN }).success).toBe(false);
  });
  it('validates profile uniqueness and role kinds', () => {
    const settings = { revision: 0, editingAvailable: false, profiles: [profile], bindings: { query: 'text-1', extract: null, keyword: null, embedding: null, rerank: null } };
    expect(ModelSettingsSchema.safeParse(settings).success).toBe(true);
    expect(ModelSettingsSchema.safeParse({ ...settings, profiles: [profile, profile] }).success).toBe(false);
    expect(ModelSettingsSchema.safeParse({ ...settings, bindings: { ...settings.bindings, embedding: 'text-1' } }).success).toBe(false);
  });
});
describe('document and graph contracts', () => {
  it('validates document timestamps, hashes and versions', () => {
    expect(DocumentSchema.parse(document).name).toBe('研究.md');
    expect(DocumentSchema.safeParse({ ...document, contentHash: 'bad' }).success).toBe(false);
    expect(DocumentSchema.safeParse({ ...document, version: 0 }).success).toBe(false);
    expect(DocumentSchema.safeParse({ ...document, createdAt: 'yesterday' }).success).toBe(false);
  });
  it('requires a valid job attempt and explicit cancellation state', () => {
    const job = { id: 'job-1', documentId: 'doc-1', operation: 'index', status: 'queued', attempt: 1, configRevision: 0, cancelRequested: false, error: null, updatedAt: document.updatedAt };
    expect(JobSchema.safeParse(job).success).toBe(true);
    expect(JobSchema.safeParse({ ...job, attempt: 0 }).success).toBe(false);
  });
  it('requires evidence and rejects non-finite graph weights', () => {
    const entity = { id: 'e1', name: '图谱', type: 'concept', description: '知识的关系', sourceChunkIds: ['c1'] };
    expect(EntitySchema.safeParse(entity).success).toBe(true);
    expect(EntitySchema.safeParse({ ...entity, sourceChunkIds: [] }).success).toBe(false);
    const relation = { id: 'r1', sourceId: 'e1', targetId: 'e2', description: '关联', keywords: [], weight: 1, sourceChunkIds: ['c1'] };
    expect(RelationSchema.safeParse(relation).success).toBe(true);
    expect(RelationSchema.safeParse({ ...relation, weight: Infinity }).success).toBe(false);
  });
  it('requires citation source chunks, without inventing a required page', () => {
    const citation = { id: 'ref-1', documentId: 'doc-1', fileName: '研究.md', chunkIds: ['c1'] };
    expect(CitationSchema.safeParse(citation).success).toBe(true);
    expect(CitationSchema.safeParse({ ...citation, chunkIds: [] }).success).toBe(false);
  });
});
describe('stream contracts', () => {
  it.each([
    { type: 'meta', requestId: 'req-1', mode: 'mix' }, { type: 'references', references: [] },
    { type: 'delta', text: 'Unicode 🧮' }, { type: 'done', finishReason: 'stop', warnings: [] },
    { type: 'error', error: { code: 'UPSTREAM', message: '失败', requestId: 'req-1' } },
    { type: 'cancelled' },
  ])('accepts the %s event', (event) => { expect(StreamEventSchema.safeParse(event).success).toBe(true); });
  it('rejects mixed terminal events and arbitrary error payloads', () => {
    expect(StreamEventSchema.safeParse({ type: 'cancelled', text: 'not a delta' }).success).toBe(false);
    expect(StreamEventSchema.safeParse({ type: 'done', error: 'bad' }).success).toBe(false);
    expect(ApiErrorSchema.safeParse({ code: 'ERROR', message: 'safe', requestId: '1', apiKey: 'secret' }).success).toBe(false);
  });
});
