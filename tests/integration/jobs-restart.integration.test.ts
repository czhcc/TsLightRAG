import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { controlledDocuments } from '../helpers/controlled-documents.js';
import { importText, waitJob } from '../helpers/document-service.js';
import { startService } from '../helpers/owned-service.js';
import { ImportResultSchema } from '@tslightrag/contracts';

it.each(['SIGKILL', 'SIGTERM'] as const)('retains every acknowledged source/job across %s and requires manual retry', async (signal) => {
  const dir = await temporaryDirectory(); const first = await controlledDocuments(dir.path, 'before-parse'); let next: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    const { result } = await importText(first.address, '202 后重启的原文'); expect(result.document.ingestion).toBeDefined(); await first.waitCheckpoint(result.job.id);
    await first.stop(signal); next = await startService(['--data-dir', dir.path]);
    const job = await waitJob(next.address, result.job.id); expect(job.status).toBe('interrupted'); expect(job.attempt).toBe(1);
    expect((await readFile(join(dir.path, 'documents', result.document.ingestion!.sourceKey))).toString()).toBe('202 后重启的原文');
    const retry = await fetch(`${next.address}/api/v1/documents/${result.document.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedJobId: job.id }) });
    const retried = ImportResultSchema.parse(await retry.json()); expect(retry.status).toBe(202); expect(retried.job.attempt).toBe(2); expect((await waitJob(next.address, retried.job.id)).result).toBeDefined();
  } finally { if (next) await next.stop(); await first.stop('SIGKILL'); await dir.cleanup(); }
});
it('preserves failed and parked attempts on restart without automatic retry', async () => {
  const dir = await temporaryDirectory(); let service = await startService(['--data-dir', dir.path]);
  try {
    const failed = await importText(service.address, '\0invalid'); const parked = await importText(service.address, 'valid');
    await waitJob(service.address, failed.result.job.id); const completed = await waitJob(service.address, parked.result.job.id); const sha = completed.result?.sha256;
    await service.stop(); service = await startService(['--data-dir', dir.path]);
    expect((await waitJob(service.address, failed.result.job.id)).attempt).toBe(1); expect((await waitJob(service.address, failed.result.job.id)).status).toBe('failed');
    expect((await waitJob(service.address, parked.result.job.id)).result?.sha256).toBe(sha);
    expect((await (await fetch(`${service.address}/api/v1/documents`)).json() as { total: number }).total).toBe(2);
  } finally { await service.stop(); await dir.cleanup(); }
});
it('fails closed on missing/corrupt originals after acknowledgement instead of silently dropping documents', async () => {
  const dir = await temporaryDirectory(); const service = await startService(['--data-dir', dir.path]);
  try {
    const { result } = await importText(service.address, 'integrity fixture'); await waitJob(service.address, result.job.id); await service.stop();
    const path = join(dir.path, 'documents', result.document.ingestion!.sourceKey); await writeFile(path, 'corrupted');
    await expect(startService(['--data-dir', dir.path])).rejects.toThrow('原文件缺失、损坏或路径不安全');
    expect(await readFile(path, 'utf8')).toBe('corrupted');
  } finally { await service.stop(); await dir.cleanup(); }
});
it('retains queued acknowledgement when killed immediately after the third 202', async () => {
  const dir = await temporaryDirectory(); const first = await controlledDocuments(dir.path, 'before-parse'); let next: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    const accepted = [];
    for (const text of ['active one', 'active two', 'queued three']) accepted.push((await importText(first.address, text)).result);
    expect((await first.stop('SIGKILL')).signal).toBe('SIGKILL'); next = await startService(['--data-dir', dir.path]);
    for (const result of accepted) {
      expect((await waitJob(next.address, result.job.id)).status).toBe('interrupted');
      expect((await readFile(join(dir.path, 'documents', result.document.ingestion!.sourceKey))).length).toBe(result.document.ingestion?.bytes);
    }
  } finally { if (next) await next.stop(); await first.stop('SIGKILL'); await dir.cleanup(); }
});
it('rejects corrupt completed artifacts on restart and keeps the damaged bytes for diagnosis', async () => {
  const dir = await temporaryDirectory(); const service = await startService(['--data-dir', dir.path]);
  try {
    const { result } = await importText(service.address, 'artifact integrity'); const job = await waitJob(service.address, result.job.id); await service.stop();
    const path = join(dir.path, 'staging', job.result!.artifactKey); await writeFile(path, 'damaged artifact');
    await expect(startService(['--data-dir', dir.path])).rejects.toThrow('解析产物缺失、损坏或路径不安全');
    expect(await readFile(path, 'utf8')).toBe('damaged artifact');
  } finally { await service.stop(); await dir.cleanup(); }
});
