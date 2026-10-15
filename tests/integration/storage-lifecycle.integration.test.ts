import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { HealthSchema } from '@tslightrag/contracts';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { indexFixture } from '../helpers/indexed-state.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { startService } from '../helpers/owned-service.js';
import { buildApp } from '../../apps/server/src/app.js';

it('boots the real server with storage, rejects a second process and retains data on restart', async () => {
  const directory = await temporaryDirectory(); const seed = await SnapshotStore.open(directory.path);
  try { await seed.transact(indexFixture); } finally { await seed.close(); }
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    service = await startService(['--data-dir', directory.path]);
    const health = HealthSchema.parse(await (await fetch(`${service.address}/api/v1/health`)).json());
    expect(health.stage).toBe('S04'); expect(health.storage.initialized).toBe(true); expect(health.usable).toBe(false);
    await expect(startService(['--data-dir', directory.path])).rejects.toThrow('STORAGE_LOCKED');
    expect(await service.stop()).toBe(0); service = undefined;
    const reopened = await SnapshotStore.open(directory.path);
    try { expect(reopened.capture().node('e1')?.description).toBe('old'); } finally { await reopened.close(); }
    service = await startService(['--data-dir', directory.path]);
    const again = HealthSchema.parse(await (await fetch(`${service.address}/api/v1/health`)).json());
    expect(again.storage.generation).toBe(health.storage.generation);
    expect(again.storage.corpusRevision).toBe(1);
  } finally { if (service) await service.stop(); await directory.cleanup(); }
});

it('CLI refuses damaged storage before listening and offers explicit inspect/recover commands', async () => {
  const directory = await temporaryDirectory(); const store = await SnapshotStore.open(directory.path);
  const generation = store.capture().generation; await store.close();
  const pointer = join(directory.path, 'workspace/default/CURRENT');
  const cli = fileURLToPath(new URL('../../apps/server/dist/storage/maintenance.js', import.meta.url));
  const run = promisify(execFile);
  try {
    await writeFile(pointer, 'corrupt-sentinel');
    await expect(startService(['--data-dir', directory.path])).rejects.toThrow();
    expect(await readFile(pointer, 'utf8')).toBe('corrupt-sentinel');
    await expect(run(process.execPath, [cli, 'recover', '--data-dir', directory.path, '--generation', generation], { env: {} })).rejects.toThrow();
    const inspected = await run(process.execPath, [cli, 'inspect', '--data-dir', directory.path, '--generation', generation], { env: {} });
    expect(JSON.parse(inspected.stdout)).toMatchObject({ validated: true, generation });
    await run(process.execPath, [cli, 'recover', '--data-dir', directory.path, '--generation', generation, '--confirm-data-loss'], { env: {} });
    const restored = await SnapshotStore.open(directory.path); await restored.close();
  } finally { await directory.cleanup(); }
});

it('returns 503 rather than healthy readiness when a published commit has fenced storage', async () => {
  const directory = await temporaryDirectory(); let armed = false;
  const storage = await SnapshotStore.open(directory.path, { hook: async (point) => {
    if (armed && point === 'after-current-sync') throw new Error('injected bookkeeping failure');
  } });
  const app = await buildApp({ storage });
  try {
    armed = true;
    await expect(storage.transact((draft) => { draft.kv.caches.set('key', true); })).rejects.toMatchObject({ published: true });
    const response = await app.inject({ url: '/api/v1/health', headers: { host: 'localhost' } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  } finally { await app.close(); await storage.close(); await directory.cleanup(); }
});
