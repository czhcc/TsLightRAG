import { readFile, writeFile, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { storageProcess } from '../helpers/storage-process.js';
import { inspectStorage, recoverStorage } from '../../apps/server/src/storage/recovery.js';

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
  const directory = await temporaryDirectory(); const process = storageProcess(directory.path, 'hold');
  try {
    await process.wait('ready');
    const lease = join(directory.path, 'locks/writer/lease');
    await writeFile(lease, JSON.stringify({ pid: 99999999, acquiredAt: '1970-01-01T00:00:00Z' }));
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
    await writeFile(join(other.path, 'sentinel'), 'keep'); await symlink(other.path, join(directory.path, 'link'));
    await expect(SnapshotStore.open(join(directory.path, 'link'))).rejects.toThrow('symlink');
    expect(await readFile(join(other.path, 'sentinel'), 'utf8')).toBe('keep');
  } finally { await directory.cleanup(); await other.cleanup(); }
});
