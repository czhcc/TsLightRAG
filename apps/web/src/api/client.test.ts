import { afterEach, expect, it, vi } from 'vitest';
import { applicationApi } from './client.js';

afterEach(() => { vi.unstubAllGlobals(); });
it('rejects non-HTTP-success responses without exposing provider data', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private body', { status: 503 })));
  await expect(applicationApi.health(new AbortController().signal)).rejects.toThrow('HTTP 503');
});
it('rejects malformed health payloads rather than declaring readiness', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'ok' })));
  await expect(applicationApi.health(new AbortController().signal)).rejects.toThrow();
});
it('forwards the cancellation signal to a same-origin model settings request', async () => {
  const settings = { revision: 0, profiles: [], editingAvailable: false, bindings: { query: null, extract: null, keyword: null, embedding: null, rerank: null } };
  const mock = vi.fn().mockResolvedValue(Response.json(settings));
  vi.stubGlobal('fetch', mock);
  const signal = new AbortController().signal;
  expect(await applicationApi.models(signal)).toEqual(settings);
  expect(mock).toHaveBeenCalledWith('/api/v1/settings/models', { signal, headers: { Accept: 'application/json' } });
});
