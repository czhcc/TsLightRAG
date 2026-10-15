import { afterEach, expect, it } from 'vitest';
import { ModelClient } from './client.js';
import { startFakeModel } from '../../../../tests/helpers/fake-model.js';
import { rerankProfile } from '../../../../tests/helpers/model-profiles.js';
const servers: Awaited<ReturnType<typeof startFakeModel>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.stop())); });
async function fixture(handler: Parameters<typeof startFakeModel>[0]) { const s = await startFakeModel(handler); servers.push(s); return s; }
it.each(['cohere-compatible', 'jina-compatible'])('sends standard %s rerank at a complete endpoint', async (protocol) => {
  const server = await fixture((_r, res) => { res.end(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] })); });
  const p = rerankProfile(`${server.url}/rerank-custom`, { protocol });
  expect(await new ModelClient().rerank(p, 'graph', ['weather', 'graph'])).toEqual({ results: [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }], warnings: [] });
  expect(server.requests[0]).toMatchObject({ path: '/rerank-custom', body: { model: 'rerank-model', query: 'graph', documents: ['weather', 'graph'], top_n: 2 } });
});
it.each([
  [{ index: 1, relevance_score: 1 }, { index: 1, relevance_score: 0 }],
  [{ index: 2, relevance_score: 1 }, { index: 0, relevance_score: 0 }],
  [{ index: 0, relevance_score: null }, { index: 1, relevance_score: 0 }],
  [{ index: 0, relevance_score: 1 }],
].map((results) => ({ results })))('rejects duplicate/out-of-range/nonfinite/incomplete results %#', async ({ results }) => {
  const server = await fixture((_r, res) => { res.end(JSON.stringify({ results })); });
  await expect(new ModelClient().rerank(rerankProfile(server.url), 'q', ['a', 'b'])).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' });
});
it('disabled rerank makes no network call; fallback returns an explicit warning', async () => {
  const server = await fixture((_r, res) => { res.writeHead(500).end('private upstream error'); }); const client = new ModelClient();
  expect((await client.rerank(rerankProfile(server.url, { enabled: false }), 'q', ['a', 'b'])).warnings).toEqual([]); expect(server.requests).toHaveLength(0);
  const fallback = await client.rerank(rerankProfile(server.url, { failurePolicy: 'fallback-with-warning' }), 'q', ['a', 'b']); expect(fallback.results.map((r) => r.index)).toEqual([0, 1]); expect(fallback.warnings).toHaveLength(1);
});
it('explicit fallback never swallows cancellation', async () => {
  const server = await fixture(() => {}); const controller = new AbortController(); controller.abort();
  await expect(new ModelClient().rerank(rerankProfile(server.url, { failurePolicy: 'fallback-with-warning' }), 'q', ['a'], controller.signal)).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
});

it('enabled rerank without a bound model reports a configuration error', async () => {
  await expect(new ModelClient().rerank(undefined, 'q', ['a'], undefined, true)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
});
