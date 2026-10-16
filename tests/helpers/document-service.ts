import { ImportResultSchema, JobSchema } from '@tslightrag/contracts';
import { startService } from './owned-service.js';
export async function importText(address: string, text: string, name = 'note.txt') {
  const response = await fetch(`${address}/api/v1/documents/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, name }) });
  return { response, result: ImportResultSchema.parse(await response.json()) };
}
export async function waitJob(address: string, id: string, expected = ['processed', 'awaiting_configuration', 'awaiting_indexing', 'failed', 'cancelled', 'interrupted']) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const response = await fetch(`${address}/api/v1/jobs/${id}`); const job = JobSchema.parse(await response.json());
    if (expected.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Persisted job did not reach expected state');
}
export async function withService(work: (service: Awaited<ReturnType<typeof startService>>) => Promise<void>) {
  const service = await startService(); try { await work(service); } finally { await service.stop(); }
}
