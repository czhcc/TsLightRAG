import type { ChunkOptions, TextChunk } from '../core/chunker.js';
import { Worker } from 'node:worker_threads';
import { ParsedDocumentSchema } from '@tslightrag/contracts';
import type { ParsedDocument } from '@tslightrag/contracts';
import { fail, formatOf, limitsFor, ParserError } from './common.js';
import type { Limits } from './common.js';

// Shared admission control: no unbounded worker spawning under concurrent jobs.
let active = 0;
const waiters: { enter: () => void; abort: () => void; signal: AbortSignal }[] = [];
async function acquire(signal: AbortSignal) {
  if (signal.aborted) fail('PARSER_CANCELLED', '解析已取消');
  if (active < 2) { active++; return; }
  if (waiters.length >= 8) fail('PARSER_BUSY', '解析队列已满');
  await new Promise<void>((resolve, reject) => {
    const item = { signal, enter: resolve, abort: () => {
      const i = waiters.indexOf(item); if (i >= 0) waiters.splice(i, 1); reject(new ParserError('PARSER_CANCELLED', '解析已取消'));
    } }; waiters.push(item); signal.addEventListener('abort', item.abort, { once: true });
  });
}
function release() { const next = waiters.shift(); if (next) { next.signal.removeEventListener('abort', next.abort); next.enter(); } else active--; }
export interface ParseOptions { signal?: AbortSignal; limits?: Partial<Limits> }
async function runWorker(bytes: Uint8Array, fileName: string, options: ParseOptions, chunking?: ChunkOptions): Promise<{ document: ParsedDocument; chunks: TextChunk[] }> {
  formatOf(fileName); const limits = limitsFor(options.limits);
  if (!(bytes instanceof Uint8Array) || bytes.length > limits.inputBytes) fail('PARSER_LIMIT', '输入文件超过大小限制');
  const timeout = new AbortController(); const timer = setTimeout(() => { timeout.abort(); }, limits.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  let admitted = false; let worker: Worker | undefined; let detach = () => {};
  try {
    await acquire(signal); admitted = true;
    if (signal.aborted) fail('PARSER_CANCELLED', '解析已取消');
    const copy = new Uint8Array(bytes);
    worker = new Worker(new URL('../../dist/parsers/worker.js', import.meta.url), { workerData: { bytes: copy, fileName, limits, chunking },
      transferList: [copy.buffer], resourceLimits: { maxOldGenerationSizeMb: limits.workerHeapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      execArgv: [], stdout: true, stderr: true,
    });
    // Never relay parser/vendor diagnostics containing source data into ordinary logs.
    worker.stdout.resume(); worker.stderr.resume();
    return await new Promise<{ document: ParsedDocument; chunks: TextChunk[] }>((resolve, reject) => {
      const abort = () => { reject(new ParserError('PARSER_CANCELLED', '解析已取消')); };
      signal.addEventListener('abort', abort, { once: true });
      detach = () => { signal.removeEventListener('abort', abort); };
      worker!.once('error', () => { reject(new ParserError('PARSER_WORKER_FAILED', '解析 Worker 失败或超出资源限制')); });
      worker!.once('exit', () => { reject(new ParserError('PARSER_WORKER_FAILED', '解析 Worker 意外退出')); });
      worker!.once('message', (result: unknown) => {
        signal.removeEventListener('abort', abort);
        const response = result as { ok?: boolean; document?: unknown; code?: string; message?: string; chunks?: TextChunk[] };
        if (response.ok) {
          const parsed = ParsedDocumentSchema.safeParse(response.document);
          if (parsed.success) resolve({ document: parsed.data, chunks: response.chunks ?? [] }); else reject(new ParserError('PARSER_FAILED', '解析结果格式不合法'));
        } else reject(new ParserError(response.code ?? 'PARSER_FAILED', response.message ?? '文档解析失败'));
      });
    });
  } catch (error) {
    if (options.signal?.aborted) fail('PARSER_CANCELLED', '解析已取消');
    if (timeout.signal.aborted) fail('PARSER_TIMEOUT', '解析超过时间限制');
    throw error;
  } finally {
    detach(); clearTimeout(timer); if (worker) await worker.terminate(); if (admitted) release();
  }
}

export async function parseDocument(bytes: Uint8Array, fileName: string, options: ParseOptions = {}) {
  return (await runWorker(bytes, fileName, options)).document;
}
/** S05 entry: both parsing and BPE chunking stay off the server event loop. */
export async function prepareDocument(bytes: Uint8Array, fileName: string, chunking: ChunkOptions, options: ParseOptions = {}) {
  return runWorker(bytes, fileName, options, chunking);
}
