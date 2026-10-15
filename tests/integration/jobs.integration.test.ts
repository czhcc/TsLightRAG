import { expect, it } from 'vitest';
import { ImportResultSchema } from '@tslightrag/contracts';
import { withService, importText, waitJob } from '../helpers/document-service.js';
import { textProfile, embeddingProfile, bindings } from '../helpers/model-profiles.js';
import { startFakeModel } from '../helpers/fake-model.js';

it('retains a diagnosable parser failure; explicit repeated retry creates only one next attempt', async () => withService(async (service) => {
  const { result } = await importText(service.address, '\u0000invalid', 'bad.txt'); const first = await waitJob(service.address, result.job.id); expect(first.status).toBe('failed'); expect(first.errorCode).toBe('INVALID_CONTENT');
  const retry = () => fetch(`${service.address}/api/v1/documents/${result.document.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedJobId: first.id }) });
  const responses = await Promise.all([retry(), retry(), retry()]); const jobs = await Promise.all(responses.map(async (r) => ImportResultSchema.parse(await r.json()).job));
  expect(new Set(jobs.map((j) => j.id)).size).toBe(1); expect(jobs[0]?.attempt).toBe(2); expect(jobs[0]?.previousJobId).toBe(first.id);
  const second = await waitJob(service.address, jobs[0]!.id); expect(second.status).toBe('failed');
  expect((await (await fetch(`${service.address}/api/v1/jobs/${first.id}`)).json() as { attempt: number; status: string }).status).toBe('failed');
  const repeated = ImportResultSchema.parse(await (await retry()).json()); expect(repeated.job.id).toBe(second.id);
  expect((await fetch(`${service.address}/api/v1/documents/${result.document.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
}));
it('configured models park at the explicit S06 boundary without any model charges or fake processed state', async () => withService(async (service) => {
  const model = await startFakeModel((_r, res) => { res.writeHead(500).end('must not be called'); });
  try {
    const saved = await fetch(`${service.address}/api/v1/settings/models`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, profiles: [textProfile(model.url), embeddingProfile(model.url)], bindings: { ...bindings, rerank: null } }) }); expect(saved.status).toBe(200);
    const { result } = await importText(service.address, '已配置模型的本地文档'); const job = await waitJob(service.address, result.job.id);
    expect(job.status).toBe('awaiting_indexing'); expect(job.configRevision).toBe(1); expect(job.warnings?.some((w) => w.code === 'INDEXER_PENDING')).toBe(true); expect(model.requests).toHaveLength(0);
  } finally { await model.stop(); }
}));
it('cancels parked work idempotently and manual retry captures new configuration version', async () => withService(async (service) => {
  const { result } = await importText(service.address, 'ready text'); await waitJob(service.address, result.job.id);
  const cancel = () => fetch(`${service.address}/api/v1/jobs/${result.job.id}/cancel`, { method: 'POST' });
  expect((await (await cancel()).json() as { status: string }).status).toBe('cancelled'); expect((await (await cancel()).json() as { status: string }).status).toBe('cancelled');
  const retried = ImportResultSchema.parse(await (await fetch(`${service.address}/api/v1/documents/${result.document.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedJobId: result.job.id }) })).json());
  expect(retried.job.attempt).toBe(2); expect((await waitJob(service.address, retried.job.id)).status).toBe('awaiting_configuration');
}));
