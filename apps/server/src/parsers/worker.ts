import { parentPort, workerData } from 'node:worker_threads';
import { disableParserNetwork } from './network.js';
import { fail, formatOf, limitsFor, Output, ParserError } from './common.js';
import type { ChunkOptions } from '../core/chunker.js';
import type { Limits } from './common.js';

disableParserNetwork();
const request = workerData as { bytes: Uint8Array; fileName: string; limits: Limits; chunking?: ChunkOptions };
try {
  const limits = limitsFor(request.limits); const format = formatOf(request.fileName);
  if (request.bytes.length > limits.inputBytes) fail('PARSER_LIMIT', '输入文件超过大小限制');
  parentPort?.postMessage({ event: 'phase', phase: 'parsing' });
  const out = new Output(limits); let extra = {};
  if (format === 'pdf') extra = await (await import('./pdf.js')).parsePdf(request.bytes, out);
  else if (['docx', 'xlsx', 'pptx'].includes(format)) extra = await (await import('./office.js')).parseOffice(format, request.bytes, out);
  else (await import('./text.js')).parseText(format, request.bytes, out);
  const document = out.finish(format, request.fileName, request.bytes, extra);
  if (request.chunking) parentPort?.postMessage({ event: 'phase', phase: 'chunking' });
  const chunks = request.chunking ? (await import('../core/chunker.js')).chunkDocument(document, request.chunking) : [];
  parentPort?.postMessage({ ok: true, document, chunks });
} catch (error) {
  parentPort?.postMessage({ ok: false, code: error instanceof ParserError ? error.code : 'PARSER_FAILED',
    message: error instanceof ParserError ? error.message : '文档解析失败，文件可能损坏或不受支持' });
}
