import type { ServerResponse } from 'node:http';
import type { ModelRequest } from './fake-model.js';
import { startFakeModel } from './fake-model.js';
import { textProfile, embeddingProfile, bindings } from './model-profiles.js';
import { temporaryDirectory } from './temporary-directory.js';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { buildApp } from '../../apps/server/src/app.js';
import type { DocumentServiceOptions } from '../../apps/server/src/documents/service.js';
import { ImportResultSchema } from '@tslightrag/contracts';
export const empty = { entities: [], relationships: [] };
export function kg(beta = false) {
  return { entities: [{ name: 'Alpha', type: 'Organization', description: 'Alpha develops graph systems.' },
    { name: 'Beta', type: 'Organization', description: 'Beta cooperates with Alpha.' },
    ...(beta ? [{ name: 'Gamma', type: 'Concept', description: 'Gamma is a search method.' }] : [])],
  relationships: [{ source: beta ? 'Beta' : 'Alpha', target: beta ? 'Alpha' : 'Beta', keywords: 'research, collaboration',
    description: 'Alpha and Beta cooperate.', strength: beta ? 3 : 2 },
    ...(beta ? [{ source: 'Alpha', target: 'Gamma', keywords: 'search', description: 'Alpha uses Gamma.', strength: 0.2 }] : [])] };
}
export function reply(response: ServerResponse, value: unknown, finish = 'stop') {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: finish }] }));
}
export function kgHandler(request: ModelRequest, response: ServerResponse) {
  const body = request.body as { input?: string[]; messages?: {role: string; content: string}[] };
  if (body.input) {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: body.input.map((s, index) => ({ index, embedding: [s.length, 1] })).reverse() }));
  } else {
    const messages = body.messages!;
    reply(response, messages.some((m) => m.role === 'assistant') ? empty : kg(messages.some((m) => m.content.includes('second document'))));
  }
}
export async function indexingHarness(options: { handler?: typeof kgHandler; documentOptions?: DocumentServiceOptions; storageHook?: Parameters<typeof SnapshotStore.open>[1] } = {}) {
  const directory = await temporaryDirectory(); const storage = await SnapshotStore.open(directory.path, options.storageHook);
  const app = await buildApp({ storage, ...(options.documentOptions ? { documentOptions: options.documentOptions } : {}) });
  const model = await startFakeModel(options.handler ?? kgHandler);
  const saved = await app.inject({ method: 'PUT', url: '/api/v1/settings/models', payload: { expectedRevision: 0,
    profiles: [textProfile(model.url, {timeoutMs: 10000}), embeddingProfile(model.url, {timeoutMs: 10000})], bindings: { ...bindings, rerank: null } } });
  if (saved.statusCode !== 200) throw new Error(saved.body);
  return { storage, app, model, directory,
    async import(text: string) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/documents/text', payload: { name: 'knowledge.txt', text } });
      return ImportResultSchema.parse(response.json());
    },
    async wait(id: string) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const job = storage.capture().job(id)!;
        if (['processed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('Index job timed out');
    },
    async close() { await app.close(); await model.stop(); await storage.close(); await directory.cleanup(); },
  };
}
