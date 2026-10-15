import { expect, it } from 'vitest';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { controlledDocuments } from '../helpers/controlled-documents.js';
import { importText, waitJob } from '../helpers/document-service.js';

it.each(['before-parse', 'after-parse', 'before-final'] as const)('cancels at real persisted %s boundary without publishing a successful result', async (point) => {
  const dir = await temporaryDirectory(); const service = await controlledDocuments(dir.path, point);
  try {
    const { result } = await importText(service.address, `取消窗口 ${point}`);
    await service.waitCheckpoint(result.job.id);
    const progress = await (await fetch(`${service.address}/api/v1/jobs/${result.job.id}`)).json() as { phase: string };
    expect(progress.phase).toBe(point === 'before-parse' ? 'parsing' : point === 'after-parse' ? 'chunking' : 'persisting_parse');
    const response = await fetch(`${service.address}/api/v1/jobs/${result.job.id}/cancel`, { method: 'POST' }); expect(response.status).toBe(200);
    const job = await waitJob(service.address, result.job.id, ['cancelled']); expect(job.cancelRequested).toBe(true); expect(job.result).toBeUndefined();
    const detail = await (await fetch(`${service.address}/api/v1/documents/${result.document.id}`)).json() as { document: { status: string } }; expect(detail.document.status).toBe('cancelled');
    expect((await fetch(`${service.address}/api/v1/documents/${result.document.id}/parsed`)).status).toBe(409);
    expect((await service.stop()).code).toBe(0);
  } finally { await service.stop('SIGKILL'); await dir.cleanup(); }
});
it('cancels queued tasks and applies backpressure without losing accepted originals', async () => {
  const dir = await temporaryDirectory(); const service = await controlledDocuments(dir.path, 'before-parse');
  try {
    const first = await importText(service.address, 'one'); const second = await importText(service.address, 'two');
    await service.waitCheckpoint(first.result.job.id); await service.waitCheckpoint(second.result.job.id);
    const queued = await importText(service.address, 'three');
    expect((await (await fetch(`${service.address}/api/v1/jobs/${queued.result.job.id}`)).json() as { status: string }).status).toBe('queued');
    await fetch(`${service.address}/api/v1/jobs/${queued.result.job.id}/cancel`, { method: 'POST' });
    expect((await waitJob(service.address, queued.result.job.id)).status).toBe('cancelled');
    for (let i = 0; i < 8; i++) expect((await importText(service.address, `queued ${String(i)}`)).response.status).toBe(202);
    const full = await fetch(`${service.address}/api/v1/documents/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'full.txt', text: 'capacity exceeded' }) });
    expect(full.status).toBe(429);
    expect((await service.stop()).code).toBe(0);
  } finally { await service.stop('SIGKILL'); await dir.cleanup(); }
});
it('configuration changes during parsing are explicit and do not mix captured versions', async () => {
  const dir = await temporaryDirectory(); const service = await controlledDocuments(dir.path, 'after-parse');
  try {
    const { result } = await importText(service.address, 'captured config'); await service.waitCheckpoint(result.job.id);
    expect((await fetch(`${service.address}/api/v1/settings/models`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, profiles: [], bindings: { query: null, extract: null, keyword: null, embedding: null, rerank: null } }) })).status).toBe(200);
    service.release(); const job = await waitJob(service.address, result.job.id);
    expect(job.configRevision).toBe(0); expect(job.status).toBe('awaiting_configuration'); expect(job.warnings?.some((w) => w.code === 'CONFIG_CHANGED')).toBe(true);
  } finally { await service.stop(); await dir.cleanup(); }
});
