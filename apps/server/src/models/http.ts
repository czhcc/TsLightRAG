import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrivateProfile } from './config.js';
import { ModelError, invalid } from './errors.js';
import { modelUrl, resolveModel } from './url.js';

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
class Gate {
  active = 0;
  private waiters: { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal; abort: () => void }[] = [];
  async acquire(limit: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < limit) { this.active++; return; }
    if (this.waiters.length >= 64) throw new ModelError('MODEL_BUSY', '模型请求队列已满', 429);
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => {
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
        reject(new ModelError('MODEL_CANCELLED', '模型请求已取消', 499));
      } };
      this.waiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else this.active--;
  }
  get idle() { return this.active === 0 && this.waiters.length === 0; }
}
class Retryable extends Error { constructor(readonly waitMs: number) { super('retryable'); } }
export function retryAfter(value: string | undefined, cap: number, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(cap, Math.max(0, ms)) : 0;
}
export async function* responseChunks(response: IncomingMessage) {
  let bytes = 0;
  for await (const chunk of response) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += data.length;
    if (bytes > MAX_RESPONSE_BYTES) throw new ModelError('MODEL_RESPONSE_TOO_LARGE', '模型响应超过大小限制');
    yield data;
  }
}
export async function responseJson(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of responseChunks(response)) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw invalid('模型响应不是有效 JSON；请确认 Base URL 指向模型 API，而不是网页或管理界面'); }
}
export class ModelTransport {
  private global = new Gate();
  private gates = new Map<string, Gate>();
  async run<T>(profile: PrivateProfile, body: unknown, signal: AbortSignal | undefined,
    consume: (response: IncomingMessage) => Promise<T>, emitted: () => boolean = () => false): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => { timeout.abort(); }, profile.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const gate = this.gates.get(profile.id) ?? new Gate(); this.gates.set(profile.id, gate);
    let acquired = false; let globalAcquired = false;
    try {
      await gate.acquire(profile.maxConcurrency, combined); acquired = true;
      await this.global.acquire(16, combined); globalAcquired = true;
      for (let attempt = 0; ; attempt++) {
        try { return await this.once(profile, body, combined, consume); }
        catch (error) {
          if (combined.aborted) throw error;
          if (error instanceof ModelError || emitted()) throw error;
          if (attempt >= profile.maxRetries) throw new ModelError('MODEL_UNAVAILABLE', '模型请求失败，已达到有限重试上限');
          const backoff = Math.min(profile.maxRetryDelayMs, profile.retryBaseMs * 2 ** attempt);
          await delay(error instanceof Retryable ? Math.max(backoff, error.waitMs) : backoff, undefined, { signal: combined });
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new ModelError('MODEL_CANCELLED', '模型请求已取消', 499);
      if (timeout.signal.aborted) throw new ModelError('MODEL_TIMEOUT', '模型请求超时', 504);
      if (error instanceof ModelError) throw error;
      throw new ModelError('MODEL_NETWORK', '模型连接或传输失败');
    } finally {
      clearTimeout(timer);
      if (globalAcquired) this.global.release();
      if (acquired) gate.release();
      if (gate.idle) this.gates.delete(profile.id);
    }
  }
  private async once<T>(profile: PrivateProfile, body: unknown, signal: AbortSignal, consume: (response: IncomingMessage) => Promise<T>) {
    const url = modelUrl(profile.endpoint, profile.kind);
    const resolution = resolveModel(url.hostname);
    let onAbort: (() => void) | undefined;
    const addresses = await Promise.race([resolution, new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new ModelError('MODEL_CANCELLED', '模型请求已取消', 499)); };
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    })]).finally(() => { if (onAbort) signal.removeEventListener('abort', onAbort); });
    signal.throwIfAborted();
    const data = JSON.stringify(body);
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new ModelError('MODEL_INPUT_TOO_LARGE', '模型请求超过大小限制', 413);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST', signal, agent: false,
        lookup: (_hostname, options, callback) => {
          const first = addresses[0];
          if (!first) return callback(new Error('No address'), '', 4);
          if (options.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        },
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(data), ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}) },
      }, resolve);
      outgoing.on('error', reject); outgoing.end(data);
    });
    try {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) throw new ModelError('MODEL_REDIRECT_BLOCKED', '禁止模型接口重定向');
      if (status === 401 || status === 403) throw new ModelError('MODEL_AUTH_FAILED', '模型接口拒绝认证');
      if ([429, 500, 502, 503, 504].includes(status)) throw new Retryable(retryAfter(response.headers['retry-after'], profile.maxRetryDelayMs));
      if (status < 200 || status >= 300) throw new ModelError('MODEL_HTTP_ERROR', `模型接口返回 HTTP ${String(status)}`);
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new ModelError('MODEL_RESPONSE_TOO_LARGE', '模型响应超过大小限制');
      return await consume(response);
    } finally { response.destroy(); }
  }
}
