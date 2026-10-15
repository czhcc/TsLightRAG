import { afterEach, expect, it } from 'vitest';
import { ModelClient } from './client.js';
import { startFakeModel } from '../../../../tests/helpers/fake-model.js';
import { chatReply, textProfile } from '../../../../tests/helpers/model-profiles.js';
const servers: Awaited<ReturnType<typeof startFakeModel>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.stop())); });
async function fixture(handler: Parameters<typeof startFakeModel>[0]) { const s = await startFakeModel(handler); servers.push(s); return s; }
const messages = [{ role: 'user' as const, content: 'distinct input: 中国 🧮' }];
it('sends actual OpenAI request fields/auth and returns text/usage', async () => {
  const server = await fixture((_r, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(chatReply)); });
  const client = new ModelClient(); const profile = textProfile(`${server.url}/proxy/v1/`);
  expect(await client.chat(profile, messages)).toEqual({ text: 'Hello connection test', finishReason: 'stop', usage: chatReply.usage });
  expect(server.requests[0]).toMatchObject({ method: 'POST', path: '/proxy/v1/chat/completions', headers: { authorization: 'Bearer synthetic-s03-secret' },
    body: { model: 'text-model', messages, stream: false, temperature: 0, max_tokens: 2048 } });
});
it('decodes split UTF-8/CRLF/multiline SSE, empty and usage-only frames', async () => {
  const server = await fixture((_r, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const payload = Buffer.from(': keepalive\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\r\n\r\n'
      + 'data: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中国 🧮"},"finish_reason":null}]}\r\n\r\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: {"choices":[],"usage":{"total_tokens":5}}\r\n\r\ndata: [DONE]\r\n\r\n');
    let i = 0; const send = () => { if (res.destroyed) return; if (i === payload.length) { res.end(); return; } res.write(payload.subarray(i, i + 1)); i++; setImmediate(send); }; send();
  });
  const deltas: string[] = [];
  expect(await new ModelClient().chat(textProfile(server.url), messages, { onDelta: (s) => { deltas.push(s); } })).toEqual({ text: '中国 🧮', finishReason: 'stop', usage: { total_tokens: 5 } });
  expect(deltas).toEqual(['中国 🧮']); expect(server.requests[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
});
it('converts nonstream JSON when stream was requested', async () => {
  const server = await fixture((_r, res) => { res.end(JSON.stringify(chatReply)); }); const deltas: string[] = [];
  await new ModelClient().chat(textProfile(server.url), messages, { onDelta: (s) => { deltas.push(s); } }); expect(deltas).toEqual(['Hello connection test']);
});
it.each([
  { choices: [] }, { choices: [{ message: { content: ' ' }, finish_reason: 'stop' }] },
  { choices: [{ message: { content: 'yes', tool_calls: [{}] }, finish_reason: 'tool_calls' }] },
  { choices: [{ message: { content: 'yes' }, finish_reason: 'content_filter' }] },
  { error: 'synthetic-s03-secret' },
])('rejects malformed/empty/tool replies without replay %#', async (reply) => {
  const server = await fixture((_r, res) => { res.end(JSON.stringify(reply)); });
  await expect(new ModelClient().chat(textProfile(server.url, { maxRetries: 2 }), messages)).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' });
  expect(server.requests).toHaveLength(1);
});
it.each([401, 403, 400])('never retries permanent HTTP %s or leaks provider body', async (status) => {
  const server = await fixture((_r, res) => { res.writeHead(status).end('synthetic-s03-secret'); });
  const error = await new ModelClient().chat(textProfile(server.url, { maxRetries: 2 }), messages).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('synthetic-s03-secret'); expect(server.requests).toHaveLength(1);
});
it('retries 429 with bounded Retry-After and selected 5xx with a finite attempt count', async () => {
  let count = 0; const times: number[] = [];
  const server = await fixture((_r, res) => {
    times.push(Date.now()); count++;
    if (count === 1) res.writeHead(429, { 'Retry-After': '999' }).end();
    else if (count === 2) res.writeHead(503).end();
    else res.end(JSON.stringify(chatReply));
  });
  await new ModelClient().chat(textProfile(server.url, { maxRetries: 2, retryBaseMs: 5, maxRetryDelayMs: 40 }), messages);
  expect(count).toBe(3); expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(30);
  const failing = await fixture((_r, res) => { res.writeHead(429).end(); });
  await expect(new ModelClient().chat(textProfile(failing.url, { maxRetries: 1, retryBaseMs: 1 }), messages)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  expect(failing.requests).toHaveLength(2);
});
it('bounds response bytes before parsing, even for chunked bodies', async () => {
  const server = await fixture((_r, res) => { res.writeHead(200); res.write(' '.repeat(8 * 1024 * 1024)); res.end('too much'); });
  await expect(new ModelClient().chat(textProfile(server.url), messages)).rejects.toMatchObject({ code: 'MODEL_RESPONSE_TOO_LARGE' });
});
it('rejects redirects without contacting the redirected host or sending its key', async () => {
  const target = await fixture((_r, res) => { res.end(JSON.stringify(chatReply)); });
  const redirect = await fixture((_r, res) => { res.writeHead(307, { Location: `${target.url}/stolen` }).end(); });
  await expect(new ModelClient().chat(textProfile(redirect.url), messages)).rejects.toMatchObject({ code: 'MODEL_REDIRECT_BLOCKED' }); expect(target.requests).toHaveLength(0);
});
it('enforces total timeout and caller cancellation during active requests', async () => {
  const server = await fixture(() => {}); const client = new ModelClient();
  await expect(client.chat(textProfile(server.url, { timeoutMs: 100 }), messages)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  const controller = new AbortController(); const work = client.chat(textProfile(server.url), messages, { signal: controller.signal });
  setTimeout(() => { controller.abort(); }, 30); await expect(work).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
});
it('never retries after a delivered SSE delta; missing DONE is not success', async () => {
  const server = await fixture((_r, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'); });
  const deltas: string[] = [];
  await expect(new ModelClient().chat(textProfile(server.url, { maxRetries: 3 }), messages, { onDelta: (s) => { deltas.push(s); } })).rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' });
  expect(deltas).toEqual(['partial']); expect(server.requests).toHaveLength(1);
});
it('limits concurrency, bounds waiting queue and removes cancelled waiters', async () => {
  let active = 0; let peak = 0;
  const server = await fixture((_r, res) => { active++; peak = Math.max(active, peak); setTimeout(() => { active--; res.end(JSON.stringify(chatReply)); }, 35); });
  const client = new ModelClient(); const p = textProfile(server.url, { maxConcurrency: 1, timeoutMs: 5000 });
  const tasks = Array.from({ length: 66 }, () => client.chat(p, messages).then(() => 'ok', (e: unknown) => (e as { code: string }).code));
  const controller = new AbortController(); controller.abort(); await expect(client.chat(p, messages, { signal: controller.signal })).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
  const results = await Promise.all(tasks); expect(results.filter((r) => r === 'ok')).toHaveLength(65); expect(results).toContain('MODEL_BUSY'); expect(peak).toBe(1);
});
it('does not replay a network failure after a streamed delta has reached the caller', async () => {
  const server = await fixture((_r, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"delivered"},"finish_reason":null}]}\n\n');
    setTimeout(() => { res.destroy(); }, 30);
  });
  const deltas: string[] = [];
  await expect(new ModelClient().chat(textProfile(server.url, { maxRetries: 3, retryBaseMs: 1 }), messages, { onDelta: (s) => { deltas.push(s); } })).rejects.toMatchObject({ code: 'MODEL_NETWORK' });
  expect(deltas).toEqual(['delivered']); expect(server.requests).toHaveLength(1);
});
it('cancels a queued request without leaking a semaphore slot or contacting the provider', async () => {
  const server = await fixture((_r, res) => { setTimeout(() => { res.end(JSON.stringify(chatReply)); }, 60); });
  const client = new ModelClient(); const p = textProfile(server.url, { maxConcurrency: 1 });
  const first = client.chat(p, messages); const controller = new AbortController();
  const second = client.chat(p, messages, { signal: controller.signal });
  const cancelled = expect(second).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
  setTimeout(() => { controller.abort(); }, 15); await cancelled;
  const third = client.chat(p, messages); await Promise.all([first, third]); expect(server.requests).toHaveLength(2);
});
