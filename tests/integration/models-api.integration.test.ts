import { afterEach, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { startService } from '../helpers/owned-service.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { textProfile, embeddingProfile, rerankProfile, bindings, chatReply } from '../helpers/model-profiles.js';
import { TestModelResultSchema, ModelSettingsSchema, HealthSchema } from '@tslightrag/contracts';
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function setup() {
  const directory = await temporaryDirectory(); closers.push(directory.cleanup);
  const text = await startFakeModel((r, res) => {
    if (r.path !== '/text/v1/chat/completions' || !(r.body as { messages: { content: string }[] }).messages[0]?.content.includes('connection test')) { res.writeHead(400).end(); return; }
    res.end(JSON.stringify(chatReply));
  }); closers.push(text.stop);
  const embedding = await startFakeModel((r, res) => {
    if (r.path !== '/embed/v1/embeddings' || !(r.body as { input: string[] }).input[0]?.includes('connection test')) { res.writeHead(400).end(); return; }
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));
  }); closers.push(embedding.stop);
  const rerank = await startFakeModel((r, res) => {
    if (r.path !== '/rank-full' || (r.body as { query: string }).query !== 'graph retrieval') { res.writeHead(400).end(); return; }
    res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] }));
  }); closers.push(rerank.stop);
  const service = await startService(['--data-dir', directory.path]); closers.push(service.stop);
  const profiles = [textProfile(`${text.url}/text/v1`), embeddingProfile(`${embedding.url}/embed/v1`, { apiKey: 'embedding-synthetic-secret' }), rerankProfile(`${rerank.url}/rank-full`, { apiKey: 'rerank-synthetic-secret' })];
  return { directory: directory.path, service, profiles, servers: [text, embedding, rerank] };
}
async function settings(address: string) { return ModelSettingsSchema.parse(await (await fetch(`${address}/api/v1/settings/models`)).json()); }
async function send(address: string, method: 'PUT' | 'POST', body: unknown, suffix = '', headers = {}) {
  return fetch(`${address}/api/v1/settings/models${suffix}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
it('tests three distinct unsaved candidate endpoints with no indexing/save side effects', async () => {
  const { service, profiles, servers } = await setup();
  const before = HealthSchema.parse(await (await fetch(`${service.address}/api/v1/health`)).json());
  for (const profile of profiles) {
    const response = await send(service.address, 'POST', { profile, expectedRevision: 0 }, '/test');
    expect(response.status).toBe(200); expect(TestModelResultSchema.parse(await response.json()).kind).toBe(profile.kind);
  }
  expect(servers.map((s) => s.requests.length)).toEqual([1, 1, 1]);
  expect((await settings(service.address)).revision).toBe(0); expect((await settings(service.address)).profiles).toEqual([]);
  expect(HealthSchema.parse(await (await fetch(`${service.address}/api/v1/health`)).json()).storage).toEqual(before.storage);
});
it('saves without sending requests; survives service restart with masked keys and default role reuse', async () => {
  const { directory, service, profiles, servers } = await setup();
  const result = await send(service.address, 'PUT', { profiles, bindings, expectedRevision: 0 }); expect(result.status).toBe(200);
  const saved = ModelSettingsSchema.parse(await result.json()); expect(saved.revision).toBe(1); expect(saved.embeddingSpaceId).toMatch(/^[a-f0-9]{64}$/);
  expect(servers.map((s) => s.requests.length)).toEqual([0, 0, 0]);
  const health = HealthSchema.parse(await (await fetch(`${service.address}/api/v1/health`)).json()); expect(health.models).toEqual({ configured: true, missingRoles: [] }); expect(health.usable).toBe(true);
  expect(await service.stop()).toBe(0);
  const restarted = await startService(['--data-dir', directory]); closers.push(restarted.stop);
  expect(await settings(restarted.address)).toEqual(saved);
  const p = { ...profiles[0]! }; delete p.apiKey;
  expect((await send(restarted.address, 'POST', { expectedRevision: 1, profile: p }, '/test')).status).toBe(200);
  expect(servers[0]?.requests[0]?.headers.authorization).toBe('Bearer synthetic-s03-secret');
  expect((await stat(join(directory, 'config/app.json'))).mode & 0o777).toBe(0o600);
});
it('returns 409 on stale revisions and keeps all saved fields', async () => {
  const { service, profiles } = await setup(); const body = { profiles, bindings, expectedRevision: 0 };
  expect((await send(service.address, 'PUT', body)).status).toBe(200); const saved = await settings(service.address);
  expect((await send(service.address, 'PUT', body)).status).toBe(409); expect(await settings(service.address)).toEqual(saved);
  expect((await send(service.address, 'POST', { profile: profiles[0], expectedRevision: 0 }, '/test')).status).toBe(409);
});
it('rejects foreign-origin writes/tests and non-JSON form writes without model requests', async () => {
  const { service, profiles, servers } = await setup();
  for (const [method, body, suffix] of [['PUT', { profiles, bindings, expectedRevision: 0 }, ''], ['POST', { profile: profiles[0], expectedRevision: 0 }, '/test']] as const) {
    expect((await send(service.address, method, body, suffix, { Origin: 'http://evil.example' })).status).toBe(403);
  }
  expect((await send(service.address, 'PUT', { profiles, bindings, expectedRevision: 0 }, '', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  expect((await fetch(`${service.address}/api/v1/settings/models`, { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'profiles=[]' })).status).toBe(415);
  expect(servers.map((s) => s.requests.length)).toEqual([0, 0, 0]); expect((await settings(service.address)).revision).toBe(0);
});
it('key omit/clear/replace is real on the wire and endpoint edits cannot forward an old key', async () => {
  const { service, profiles, servers } = await setup(); let revision = 0;
  await send(service.address, 'PUT', { profiles, bindings, expectedRevision: revision++ });
  const profile = { ...profiles[0]! }; delete profile.apiKey;
  for (const key of [undefined, null, 'new-synthetic-key']) {
    if (key === undefined) delete profile.apiKey; else profile.apiKey = key;
    expect((await send(service.address, 'PUT', { profiles: [profile, ...profiles.slice(1)], bindings, expectedRevision: revision++ })).status).toBe(200);
    const test = { ...profile }; delete test.apiKey;
    expect((await send(service.address, 'POST', { profile: test, expectedRevision: revision }, '/test')).status).toBe(200);
  }
  expect(servers[0]?.requests.map((r) => r.headers.authorization)).toEqual(['Bearer synthetic-s03-secret', undefined, 'Bearer new-synthetic-key']);
  delete profile.apiKey; profile.endpoint = `${servers[1]!.url}/different/v1`;
  expect((await send(service.address, 'POST', { profile, expectedRevision: revision }, '/test')).status).toBe(409);
  expect(servers[1]?.requests).toHaveLength(0);
});
it('keeps synthetic keys out of GET, errors and server output, even if upstream echoes them', async () => {
  const { service, profiles, directory } = await setup(); let output = ''; service.child.stdout.on('data', (b: Buffer) => { output += b.toString(); }); service.child.stderr.on('data', (b: Buffer) => { output += b.toString(); });
  const upstream = await startFakeModel((_r, res) => { res.writeHead(401).end('synthetic-s03-secret'); }); closers.push(upstream.stop);
  const saved = await send(service.address, 'PUT', { profiles, bindings, expectedRevision: 0 }); const savedBody = await saved.text();
  const failed = await send(service.address, 'POST', { expectedRevision: 1, profile: textProfile(upstream.url) }, '/test'); const errorBody = await failed.text();
  expect(failed.status).toBe(502); expect(errorBody).toContain('MODEL_AUTH_FAILED');
  const getBody = await (await fetch(`${service.address}/api/v1/settings/models`)).text();
  for (const body of [savedBody, errorBody, getBody, output]) for (const key of ['synthetic-s03-secret', 'embedding-synthetic-secret', 'rerank-synthetic-secret']) expect(body).not.toContain(key);
  expect(await readFile(join(directory, 'config/app.json'), 'utf8')).toContain('synthetic-s03-secret'); // Deliberately local restricted plaintext, not an encryption claim.
});

it('browser disconnect cancels the upstream candidate request and leaves config unchanged', async () => {
  const { service } = await setup(); let upstreamClosed = false; let received = false;
  const upstream = await startFakeModel((_r, res) => { received = true; res.on('close', () => { upstreamClosed = true; }); }); closers.push(upstream.stop);
  const controller = new AbortController();
  const request = fetch(`${service.address}/api/v1/settings/models/test`, { method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, profile: textProfile(upstream.url) }) });
  const pending = request.catch((error: unknown) => error);
  const deadline = Date.now() + 2000;
  while (!received && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(received).toBe(true); controller.abort(); await pending;
  while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(upstreamClosed).toBe(true); expect((await settings(service.address)).revision).toBe(0);
});
