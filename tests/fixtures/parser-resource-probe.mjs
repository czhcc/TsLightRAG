import { parseDocument } from '../../apps/server/dist/parsers/index.js';
try {
  await parseDocument(Buffer.from('paragraph 中文\n\n'.repeat(10000)), 'memory.md', { limits: { workerHeapMb: 8, timeoutMs: 4000 } });
  throw new Error('Expected the worker heap limit to reject this document');
} catch (error) {
  if (error.code !== 'PARSER_WORKER_FAILED') throw error;
  process.stdout.write('worker heap failure isolated\n');
}
