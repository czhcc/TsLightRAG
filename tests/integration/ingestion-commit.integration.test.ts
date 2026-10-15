import { expect, it } from 'vitest';
import { readFile, rename, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { buildApp } from '../../apps/server/src/app.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { ImportResultSchema } from '@tslightrag/contracts';
import { indexFixture } from '../helpers/indexed-state.js';
import { withService, importText, waitJob } from '../helpers/document-service.js';

it.each(['before-current', 'after-current'] as const)('never returns 202 on %s snapshot failure; published state is explicitly fenced', async (point) => {
  const dir = await temporaryDirectory(); let armed = false;
  const storage = await SnapshotStore.open(dir.path, { hook: async (current) => { if (armed && current === point) throw new Error('synthetic-private-key'); } });
  const app = await buildApp({ storage });
  try {
    armed = true; const response = await app.inject({ method: 'POST', url: '/api/v1/documents/text', headers: { host: 'localhost' }, payload: { name: 'durable.txt', text: 'durable source' } });
    expect(response.statusCode).toBe(point === 'before-current' ? 500 : 503); expect(response.body).not.toContain('synthetic-private-key'); expect(response.json()).toHaveProperty('requestId');
    if (point === 'before-current') {
      expect(storage.capture().documents()).toHaveLength(0); armed = false;
      const retried = await app.inject({ method: 'POST', url: '/api/v1/documents/text', headers: { host: 'localhost' }, payload: { name: 'durable.txt', text: 'durable source' } });
      expect(retried.statusCode).toBe(202); const result = ImportResultSchema.parse(retried.json()); expect(await readFile(join(dir.path, 'documents', result.document.ingestion!.sourceKey), 'utf8')).toBe('durable source');
    } else {
      expect(response.json()).toMatchObject({ code: 'DOCUMENT_PUBLISHED_UNCERTAIN' }); expect(storage.healthy).toBe(false);
      expect((await app.inject({ url: '/api/v1/health', headers: { host: 'localhost' } })).statusCode).toBe(503);
    }
  } finally { armed = false; await app.close(); await storage.close(); }
  try {
    const restored = await SnapshotStore.open(dir.path); const reopened = await buildApp({ storage: restored });
    try { expect(restored.capture().documents()).toHaveLength(1); expect(restored.capture().documents()[0]?.status).toBe('interrupted'); }
    finally { await reopened.close(); await restored.close(); }
  } finally { await dir.cleanup(); }
});
it('a completed indexed snapshot wins over cancellation without losing its contributions', async () => {
  const dir = await temporaryDirectory(); const storage = await SnapshotStore.open(dir.path); await storage.transact(indexFixture); const app = await buildApp({ storage });
  try {
    const revision = storage.capture().corpusRevision;
    const response = await app.inject({ method: 'POST', url: '/api/v1/jobs/job-1/cancel', headers: { host: 'localhost' } });
    expect(response.json()).toMatchObject({ status: 'processed', cancelRequested: false }); expect(storage.capture().corpusRevision).toBe(revision); expect(storage.capture().node('e1')).toBeDefined();
  } finally { await app.close(); await storage.close(); await dir.cleanup(); }
});
it('refuses a replaced staging directory symlink and surfaces actual artifact write failure', async () => withService(async (service) => {
  const good = await importText(service.address, 'good artifact'); await waitJob(service.address, good.result.job.id);
  await rename(join(service.dataDir, 'staging'), join(service.dataDir, 'retained-staging'));
  await mkdir(join(service.dataDir, 'outside')); await symlink(join(service.dataDir, 'outside'), join(service.dataDir, 'staging'));
  expect((await fetch(`${service.address}/api/v1/documents/${good.result.document.id}/parsed`)).status).toBe(409);
  const bad = await importText(service.address, 'bad artifact'); const job = await waitJob(service.address, bad.result.job.id);
  expect(job.status).toBe('failed'); expect(job.errorCode).toBe('ARTIFACT_WRITE_FAILED'); expect(job.result).toBeUndefined();
}));
