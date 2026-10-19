import { readFile, writeFile, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { storageProcess } from '../helpers/storage-process.js';
import { inspectStorage, recoverStorage } from '../../apps/server/src/storage/recovery.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';

it('rejects another writer in the same process and permits a different data directory', async () => {
  const directory = await temporaryDirectory(); const other = await temporaryDirectory();
  const first = await SnapshotStore.open(directory.path);
  try {
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow('STORAGE_LOCKED');
    const second = await SnapshotStore.open(other.path); await second.close();
    await expect(inspectStorage(directory.path)).rejects.toThrow('STORAGE_LOCKED');
    await expect(recoverStorage(directory.path, first.capture().generation, true)).rejects.toThrow('STORAGE_LOCKED');
  } finally { await first.close(); await directory.cleanup(); await other.cleanup(); }
});

it('does not steal an aged live lock or trust forged owner metadata, and releases on SIGKILL', async () => {
  const directory = await temporaryDirectory();
  const initialized = await SnapshotStore.open(directory.path); await initialized.close();
  const lease = join(directory.path, 'locks/writer/lease');
  const forged = JSON.stringify({ pid: 99999999, acquiredAt: '1970-01-01T00:00:00Z' });
  await writeFile(lease, forged); await utimes(lease, new Date(0), new Date(0));
  const process = storageProcess(directory.path, 'hold');
  try {
    await process.wait('ready');
    // Windows locks prevent another handle from writing; POSIX flock is advisory.
    if (globalThis.process.platform === 'win32') await expect(writeFile(lease, forged)).rejects.toThrow();
    else await writeFile(lease, forged);
    await utimes(lease, new Date(0), new Date(0));
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow('STORAGE_LOCKED');
    expect((await process.stop('SIGKILL')).signal).toBe('SIGKILL');
    const reopened = await SnapshotStore.open(directory.path);
    try {
      expect(reopened.capture().revision).toBe(0);
      expect(JSON.parse(await readFile(lease, 'utf8'))).toMatchObject({ pid: globalThis.process.pid });
    } finally { await reopened.close(); }
  } finally { await process.stop('SIGKILL'); await directory.cleanup(); }
});

it('refuses a symlink data directory before creating workspace files outside it', async () => {
  const directory = await temporaryDirectory(); const other = await temporaryDirectory();
  try {
    await writeFile(join(other.path, 'sentinel'), 'keep'); await symlink(other.path, join(directory.path, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(SnapshotStore.open(join(directory.path, 'link'))).rejects.toThrow('symlink');
    expect(await readFile(join(other.path, 'sentinel'), 'utf8')).toBe('keep');
  } finally { await directory.cleanup(); await other.cleanup(); }
});

it.runIf(process.platform === 'linux')('shares Linux flock ownership with pre-upgrade writers in both directions', async () => {
  const directory = await temporaryDirectory(); let storage = await SnapshotStore.open(directory.path);
  const lease = join(directory.path, 'locks/writer/lease');
  let legacy: ReturnType<typeof spawn> | undefined;
  try {
    await expect(promisify(execFile)('flock', ['-n', lease, process.execPath, '-e', 'process.exit(0)'])).rejects.toMatchObject({ code: 1 });
    await storage.close();
    legacy = spawn('flock', ['--no-fork', '-n', lease, process.execPath, '-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => legacy?.kill('SIGKILL'), 5000);
    try {
      await Promise.race([once(legacy.stdout!, 'data'), once(legacy, 'exit').then(() => { throw new Error('Legacy flock process exited before readiness'); })]);
    } finally { clearTimeout(timer); }
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow('STORAGE_LOCKED');
    const exited = once(legacy, 'exit'); legacy.kill('SIGKILL'); await exited; legacy = undefined;
    storage = await SnapshotStore.open(directory.path);
  } finally {
    if (legacy && legacy.exitCode === null && legacy.signalCode === null) { const exited = once(legacy, 'exit'); legacy.kill('SIGKILL'); await exited; }
    await storage.close(); await directory.cleanup();
  }
});
