import { ModelProfileInputSchema } from '@tslightrag/contracts';
export function textProfile(endpoint: string, patch: Record<string, unknown> = {}) {
  const p = ModelProfileInputSchema.parse({ id: 'text', kind: 'text', protocol: 'openai-compatible', name: 'Text', endpoint, model: 'text-model', timeoutMs: 2000, maxConcurrency: 2, maxRetries: 0, apiKey: 'synthetic-s03-secret', ...patch });
  if (p.kind !== 'text') throw new Error('Fixture kind'); return p;
}
export function embeddingProfile(endpoint: string, patch: Record<string, unknown> = {}) {
  const p = ModelProfileInputSchema.parse({ id: 'embedding', kind: 'embedding', protocol: 'openai-compatible', name: 'Embedding', endpoint, model: 'embedding-model', dimensions: 2, operatorRevision: 0, timeoutMs: 2000, maxConcurrency: 2, maxRetries: 0, ...patch });
  if (p.kind !== 'embedding') throw new Error('Fixture kind'); return p;
}
export function rerankProfile(endpoint: string, patch: Record<string, unknown> = {}) {
  const p = ModelProfileInputSchema.parse({ id: 'rerank', kind: 'rerank', protocol: 'cohere-compatible', name: 'Rerank', endpoint, model: 'rerank-model', timeoutMs: 2000, maxConcurrency: 2, maxRetries: 0, ...patch });
  if (p.kind !== 'rerank') throw new Error('Fixture kind'); return p;
}
export const bindings = { query: 'text', extract: null, keyword: null, embedding: 'embedding', rerank: 'rerank' };
export const chatReply = { choices: [{ message: { content: 'Hello connection test' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
