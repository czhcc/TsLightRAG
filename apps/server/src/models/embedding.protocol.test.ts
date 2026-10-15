import { afterEach, expect, it } from 'vitest';
import { ModelClient } from './client.js';
import { startFakeModel } from '../../../../tests/helpers/fake-model.js';
import { embeddingProfile } from '../../../../tests/helpers/model-profiles.js';
const servers: Awaited<ReturnType<typeof startFakeModel>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.stop())); });
async function fixture(handler: Parameters<typeof startFakeModel>[0]) { const s = await startFakeModel(handler); servers.push(s); return s; }
it('splits batches and reorders actual input-sensitive embeddings by index', async () => {
  const server = await fixture((r, res) => {
    const input = (r.body as { input: string[] }).input;
    res.end(JSON.stringify({ data: input.map((s, index) => ({ index, embedding: [Number(s), 1] })).reverse() }));
  });
  expect(await new ModelClient().embed(embeddingProfile(`${server.url}/proxy/v1`, { batchSize: 2 }), ['1', '2', '3'])).toEqual([[1, 1], [2, 1], [3, 1]]);
  expect(server.requests).toHaveLength(2); expect(server.requests[0]).toMatchObject({ path: '/proxy/v1/embeddings', body: { model: 'embedding-model', input: ['1', '2'], encoding_format: 'float' } });
});
it.each([
  [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [2, 3] }],
  [{ index: 0, embedding: [1, 2] }],
  [{ index: 0, embedding: [1, 2] }, { index: 2, embedding: [2, 3] }],
  [{ index: 0, embedding: [1] }, { index: 1, embedding: [2, 3] }],
  [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [2, 3] }],
  [{ index: 0, embedding: [null, 1] }, { index: 1, embedding: [2, 3] }],
].map((data) => ({ data })))('rejects duplicate/missing/range/dimension/zero/nonfinite records %#', async ({ data }) => {
  const server = await fixture((_r, res) => { res.end(JSON.stringify({ data })); });
  await expect(new ModelClient().embed(embeddingProfile(server.url, { maxRetries: 2 }), ['a', 'b'])).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' }); expect(server.requests).toHaveLength(1);
});
it('rejects nonfinite numeric JSON and cancels without dispatching the next batch', async () => {
  const bad = await fixture((_r, res) => { res.end('{"data":[{"index":0,"embedding":[1e999,1]}]}'); });
  await expect(new ModelClient().embed(embeddingProfile(bad.url), ['x'])).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' });
  const controller = new AbortController();
  const server = await fixture((_r, res) => { controller.abort(); res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 1] }] })); });
  await expect(new ModelClient().embed(embeddingProfile(server.url, { batchSize: 1 }), ['1', '2'], controller.signal)).rejects.toMatchObject({ code: 'MODEL_CANCELLED' }); expect(server.requests).toHaveLength(1);
});
