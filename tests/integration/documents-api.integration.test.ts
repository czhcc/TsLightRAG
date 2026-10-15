import { expect, it } from 'vitest';
import { readFile, stat, symlink, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DocumentDetailSchema, DocumentListSchema, ImportResultSchema } from '@tslightrag/contracts';
import { withService, importText, waitJob } from '../helpers/document-service.js';
import { documentFixture } from '../helpers/document-fixtures.js';

it('persists text/source before 202 and exposes the real job, parsed preview and unchanged corpus', async () => withService(async (service) => {
  const { response, result } = await importText(service.address, '中文证据 🧮\n\n本地文件'); expect(response.status).toBe(202);
  const bytes = await readFile(join(service.dataDir, 'documents', result.document.ingestion!.sourceKey)); expect(bytes.toString()).toBe('中文证据 🧮\n\n本地文件');
  expect((await stat(join(service.dataDir, 'documents', result.document.ingestion!.sourceKey))).mode & 0o777).toBe(0o600);
  const job = await waitJob(service.address, result.job.id); expect(job.status).toBe('awaiting_configuration'); expect(job.phase).toBe(job.status);
  expect(job.result?.chunks).toBeGreaterThan(0); expect(job.preparation?.missingRoles).toEqual(['query', 'embedding']);
  const detail = DocumentDetailSchema.parse(await (await fetch(`${service.address}/api/v1/documents/${result.document.id}`)).json()); expect(detail.document.status).toBe(job.status);
  const parsed = await (await fetch(`${service.address}/api/v1/documents/${result.document.id}/parsed`)).json() as { text: string; chunkCount: number };
  expect(parsed.text).toBe(bytes.toString()); expect(parsed.chunkCount).toBe(job.result?.chunks);
  const health = await (await fetch(`${service.address}/api/v1/health`)).json() as { usable: boolean; storage: { corpusRevision: number }; jobs: { available: boolean } };
  expect(health.usable).toBe(false); expect(health.storage.corpusRevision).toBe(0); expect(health.jobs.available).toBe(true);
}));
it('accepts real multipart Office and keeps display name separate from disk key', async () => withService(async (service) => {
  const bytes = await documentFixture('sample.docx'); const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)]), '中文 示例.docx');
  const response = await fetch(`${service.address}/api/v1/documents`, { method: 'POST', body: form }); expect(response.status).toBe(202);
  const result = ImportResultSchema.parse(await response.json()); expect(result.document.name).toBe('中文 示例.docx'); expect(result.document.ingestion?.sourceKey).toMatch(/^[a-f0-9]{64}\.blob$/);
  const job = await waitJob(service.address, result.job.id); expect(job.result?.blocks).toBe(5);
}));
it('deduplicates concurrent identical bytes and permits the same name for different contents', async () => withService(async (service) => {
  const imports = await Promise.all(Array.from({ length: 4 }, () => importText(service.address, 'same content', 'same.txt')));
  expect(new Set(imports.map((r) => r.result.document.id)).size).toBe(1); expect(imports.filter((r) => !r.result.deduplicated)).toHaveLength(1);
  const different = await importText(service.address, 'different content', 'same.txt'); expect(different.result.document.id).not.toBe(imports[0]?.result.document.id);
  const listing = DocumentListSchema.parse(await (await fetch(`${service.address}/api/v1/documents?offset=1&limit=1`)).json()); expect(listing.total).toBe(2); expect(listing.items).toHaveLength(1);
}));
it('rejects invalid names/formats, invalid body, pagination and foreign Origin without accepting documents', async () => withService(async (service) => {
  for (const body of [{ name: '../secret.txt', text: 'x' }, { name: 'x.exe', text: 'x' }, { name: 'x.txt', text: '' }, { name: 'x.txt', text: ' ' }, { name: 'x.pdf', text: 'x' }]) {
    const response = await fetch(`${service.address}/api/v1/documents/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status).toBe(400);
  }
  expect((await fetch(`${service.address}/api/v1/documents?limit=0`)).status).toBe(400);
  expect((await fetch(`${service.address}/api/v1/documents?limit=101`)).status).toBe(400);
  expect((await fetch(`${service.address}/api/v1/documents/text`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'x.txt', text: 'x' }) })).status).toBe(403);
  expect((await fetch(`${service.address}/api/v1/documents/missing`)).status).toBe(404);
  expect((await (await fetch(`${service.address}/api/v1/documents`)).json() as { total: number }).total).toBe(0);
}));
it('rejects multipart traversal, empty/oversized files and extra files/fields', async () => withService(async (service) => {
  const boundary = 's05-boundary';
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../escape.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n--${boundary}--\r\n`;
  expect((await fetch(`${service.address}/api/v1/documents`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: raw })).status).toBe(400);
  for (const size of [0, 20 * 1024 * 1024 + 1]) {
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(size)]), 'x.txt');
    expect((await fetch(`${service.address}/api/v1/documents`, { method: 'POST', body: form })).status).toBe(413);
  }
  for (const extra of ['file', 'field']) {
    const form = new FormData(); form.append('file', new Blob(['x']), 'x.txt'); if (extra === 'file') form.append('other', new Blob(['y']), 'y.txt'); else form.append('unexpected', 'value');
    expect((await fetch(`${service.address}/api/v1/documents`, { method: 'POST', body: form })).status).toBeGreaterThanOrEqual(400);
  }
  expect((await (await fetch(`${service.address}/api/v1/documents`)).json() as { total: number }).total).toBe(0);
}));
it('refuses a symlink source or actual I/O conflict and does not acknowledge acceptance', async () => withService(async (service) => {
  const text = 'known input'; const hash = createHash('sha256').update(text).digest('hex'); const target = join(service.dataDir, 'documents', `${hash}.blob`);
  await symlink(join(service.dataDir, 'missing'), target);
  let response = await fetch(`${service.address}/api/v1/documents/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, name: 'x.txt' }) });
  expect(response.status).toBe(500); expect((await response.text())).not.toContain(service.dataDir);
  await rm(target); await mkdir(target);
  response = await fetch(`${service.address}/api/v1/documents/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, name: 'x.txt' }) }); expect(response.status).toBe(500);
  expect((await (await fetch(`${service.address}/api/v1/documents`)).json() as { total: number }).total).toBe(0);
}));
it('imports all nine real formats through the actual upload/worker/persisted-result path', async () => withService(async (service) => {
  for (const ext of ['txt', 'md', 'html', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'pptx']) {
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(await documentFixture(`sample.${ext}`))]), `sample.${ext}`);
    const response = await fetch(`${service.address}/api/v1/documents`, { method: 'POST', body: form }); expect(response.status).toBe(202);
    const result = ImportResultSchema.parse(await response.json()); const job = await waitJob(service.address, result.job.id);
    expect(job.status).toBe('awaiting_configuration'); expect(job.result?.chunks).toBeGreaterThan(0);
  }
}), 30000);
