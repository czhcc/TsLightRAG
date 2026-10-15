import { mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SnapshotStore, PublishedCommitError } from '../../apps/server/src/storage/snapshot.js';
import { GraphFileSchema } from '../../apps/server/src/storage/graph.js';
import { VectorFileSchema } from '../../apps/server/src/storage/vectors.js';
import { ManifestSchema, PointerSchema, sha } from '../../apps/server/src/storage/disk.js';
import type { CommitPoint } from '../../apps/server/src/storage/disk.js';
import type { FileName } from '../../apps/server/src/storage/state.js';
import { recoverStorage, inspectStorage } from '../../apps/server/src/storage/recovery.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { indexFixture } from '../helpers/indexed-state.js';
import type { WorkspaceDraft } from '../../apps/server/src/storage/state.js';

const workspace = (root: string) => join(root, 'workspace/default');
async function rewriteFile(root: string, name: string, mutate: (input: unknown) => unknown) {
  const pointer = PointerSchema.parse(JSON.parse(await readFile(join(workspace(root), 'CURRENT'), 'utf8')));
  const dir = join(workspace(root), 'generations', pointer.generation);
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
  const contents = JSON.stringify(mutate(JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown));
  await writeFile(join(dir, name), contents);
  manifest.files[name as FileName] = sha(contents);
  const manifestText = JSON.stringify(manifest); await writeFile(join(dir, 'manifest.json'), manifestText);
  pointer.manifestHash = sha(manifestText); await writeFile(join(workspace(root), 'CURRENT'), JSON.stringify(pointer));
}

it('publishes all namespaces, restores Unicode/float32/graph/statuses and captures stable old views', async () => {
  const directory = await temporaryDirectory(); let store = await SnapshotStore.open(directory.path);
  try {
    const initial = store.capture(); expect(initial.revision).toBe(0); expect(initial.corpusRevision).toBe(0);
    await store.transact(indexFixture);
    const committed = store.capture(); expect(committed.corpusRevision).toBe(1);
    expect(initial.getKV('fullDocs', 'doc-1')).toBeUndefined();
    const copy = committed.node('e1'); if (copy) copy.description = 'outside mutation';
    expect(committed.node('e1')?.description).toBe('old');
    expect(committed.getVector('chunks', 'c1')?.values).toBeInstanceOf(Float32Array);
    expect(committed.job('job-1')?.status).toBe('processed');
    expect(committed.neighbors('e1')).toEqual(['e2']);
    await store.transact((draft) => {
      const status = draft.documents.get('doc-1'); if (!status) throw new Error('Fixture missing');
      draft.documents.set('doc-1', { ...status, updatedAt: '2026-10-15T00:00:01Z' });
      const full = draft.kv.fullDocs.get('doc-1');
      if (!full || typeof full !== 'object' || Array.isArray(full)) throw new Error('Fixture missing');
      draft.kv.fullDocs.set('doc-1', { ...full, updatedAt: '2026-10-15T00:00:01Z' });
      draft.kv.caches.set('progress', 'metadata-only');
    });
    expect(store.capture().corpusRevision).toBe(1);
    expect(committed.document('doc-1')?.updatedAt).toBe('2026-10-15T00:00:00Z');
    const latest = store.capture(); const contents = latest.export();
    await store.close(); store = await SnapshotStore.open(directory.path);
    expect(store.capture().generation).toBe(latest.generation);
    expect(store.capture().export()).toEqual(contents);
    expect(store.capture().search('chunks', [1, 0], { spaceId: 'space-v1', topK: 1 })[0]?.score).toBeCloseTo(1);
    expect(store.capture().getKV('fullDocs', 'doc-1')).toMatchObject({ content: '本地文件，中文 🧮' });
  } finally { await store.close(); await directory.cleanup(); }
});

it('serializes concurrent deltas from the latest state and isolates escaped drafts', async () => {
  const directory = await temporaryDirectory(); const store = await SnapshotStore.open(directory.path);
  try {
    let escaped: WorkspaceDraft | undefined;
    const before = store.capture();
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.transact((draft) => {
      escaped = draft; draft.kv.caches.set(`entry-${String(index)}`, index);
    })));
    expect(store.capture().entries('caches')).toHaveLength(12); expect(store.capture().revision).toBe(12);
    expect(store.capture().corpusRevision).toBe(0); expect(before.entries('caches')).toEqual([]);
    escaped?.kv.caches.set('escaped', 'must not leak');
    expect(store.capture().getKV('caches', 'escaped')).toBeUndefined();
    await expect(store.transact(() => {}, { expectedRevision: 0 })).rejects.toThrow('REVISION_CONFLICT');
    await expect(store.transact(async () => {})).rejects.toThrow('synchronous');
  } finally { await store.close(); await directory.cleanup(); }
});

describe('pre-publication errors', () => {
  it.each(['after-namespace', 'after-manifest', 'before-current'] as CommitPoint[])('keeps the old snapshot on %s failure and permits retry', async (point) => {
    const directory = await temporaryDirectory(); let armed = false;
    const store = await SnapshotStore.open(directory.path, { hook: async (actual) => { if (armed && actual === point) throw new Error('injected EIO'); } });
    try {
      const before = store.capture(); armed = true;
      await expect(store.transact((draft) => { draft.kv.caches.set('key', 'new'); })).rejects.toThrow('injected EIO');
      expect(store.capture().generation).toBe(before.generation); expect(store.capture().getKV('caches', 'key')).toBeUndefined();
      armed = false; await store.transact((draft) => { draft.kv.caches.set('key', 'retry'); });
      expect(store.capture().getKV('caches', 'key')).toBe('retry');
    } finally { await store.close(); await directory.cleanup(); }
  });
});
it.each(['after-current', 'after-current-sync'] as CommitPoint[])('reports publication and fences writes on %s failure', async (point) => {
  const directory = await temporaryDirectory(); let armed = false;
  let store = await SnapshotStore.open(directory.path, { hook: async (actual) => { if (armed && actual === point) throw new Error('bookkeeping failure'); } });
  try {
    armed = true;
    const error = await store.transact((draft) => { draft.kv.caches.set('key', 'published'); }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PublishedCommitError);
    expect(error).toMatchObject({ published: true, durabilityConfirmed: point === 'after-current-sync' });
    expect(store.healthy).toBe(false); expect(() => store.capture()).toThrow('fenced');
    await expect(store.transact(() => {})).rejects.toThrow('fenced');
    await store.close(); store = await SnapshotStore.open(directory.path);
    expect(store.capture().getKV('caches', 'key')).toBe('published');
  } finally { await store.close(); await directory.cleanup(); }
});

it('does not acknowledge a real filesystem write error (including when tests run as root)', async () => {
  const directory = await temporaryDirectory(); let armed = false;
  let previous = '';
  const store = await SnapshotStore.open(directory.path, { hook: async (point, file) => {
    if (armed && point === 'after-namespace' && file === 'kv.json') {
      const generations = join(workspace(directory.path), 'generations');
      const candidate = (await readdir(generations)).find((name) => name !== previous);
      if (!candidate) throw new Error('Fixture missing candidate');
      await mkdir(join(generations, candidate, 'document-status.json'));
    }
  } });
  try {
    const before = store.capture().generation; previous = before; armed = true;
    await expect(store.transact((draft) => { draft.kv.caches.set('key', 'not durable'); })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(store.capture().generation).toBe(before);
  } finally { await store.close(); await directory.cleanup(); }
});

it('rejects corrupt CURRENT, preserves it, and supports explicit validated recovery', async () => {
  const directory = await temporaryDirectory(); const store = await SnapshotStore.open(directory.path);
  let old: string;
  try { await store.transact(indexFixture); old = store.capture().generation; }
  finally { await store.close(); }
  try {
    const pointer = join(workspace(directory.path), 'CURRENT'); await writeFile(pointer, '{broken');
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow();
    expect(await readFile(pointer, 'utf8')).toBe('{broken');
    await expect(recoverStorage(directory.path, old, false)).rejects.toThrow('confirm-data-loss');
    await expect(recoverStorage(directory.path, '../escape', true)).rejects.toThrow();
    expect((await inspectStorage(directory.path, old)).validated).toBe(true);
    await recoverStorage(directory.path, old, true);
    const reopened = await SnapshotStore.open(directory.path);
    try { expect(reopened.capture().node('e1')?.description).toBe('old'); }
    finally { await reopened.close(); }
    expect((await readdir(workspace(directory.path))).some((name) => name.startsWith('recovery-backup-'))).toBe(true);
  } finally { await directory.cleanup(); }
});

it.each(['checksum', 'manifest', 'version', 'missing-current', 'missing-file', 'current-symlink'] as const)('fails closed on %s without resetting storage', async (problem) => {
  const directory = await temporaryDirectory(); const other = await temporaryDirectory();
  const store = await SnapshotStore.open(directory.path); const generation = store.capture().generation; await store.close();
  const dir = join(workspace(directory.path), 'generations', generation); const pointerPath = join(workspace(directory.path), 'CURRENT');
  try {
    if (problem === 'checksum') await writeFile(join(dir, 'kv.json'), '{}');
    if (problem === 'manifest') await writeFile(join(dir, 'manifest.json'), '{}');
    if (problem === 'version') {
      const pointer = PointerSchema.parse(JSON.parse(await readFile(pointerPath, 'utf8')));
      await writeFile(pointerPath, JSON.stringify({ ...pointer, schemaVersion: 999 }));
    }
    if (problem === 'missing-current') await rm(pointerPath);
    if (problem === 'missing-file') await rm(join(dir, 'graph.json'));
    if (problem === 'current-symlink') {
      await writeFile(join(other.path, 'secret'), 'external-sentinel'); await rm(pointerPath);
      await symlink(join(other.path, 'secret'), pointerPath);
    }
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow();
    expect(await readdir(join(workspace(directory.path), 'generations'))).toEqual([generation]);
    if (problem === 'current-symlink') expect(await readFile(join(other.path, 'secret'), 'utf8')).toBe('external-sentinel');
  } finally { await directory.cleanup(); await other.cleanup(); }
});

it.each(['mixed-space', 'dangling-edge', 'missing-source', 'missing-vector'] as const)('checks %s even with recomputed valid file checksums', async (problem) => {
  const directory = await temporaryDirectory(); const store = await SnapshotStore.open(directory.path);
  try { await store.transact(indexFixture); } finally { await store.close(); }
  try {
    if (problem === 'mixed-space' || problem === 'missing-vector') {
      await rewriteFile(directory.path, 'vectors-entities.json', (input) => {
        const file = VectorFileSchema.parse(input);
        if (problem === 'mixed-space' && file.space) file.space.id = 'different';
        else file.rows.pop();
        return file;
      });
    } else await rewriteFile(directory.path, 'graph.json', (input) => {
      const file = GraphFileSchema.parse(input);
      if (problem === 'dangling-edge') file.nodes.pop();
      else if (file.nodes[0]) file.nodes[0].sourceChunkIds = ['missing-chunk'];
      return file;
    });
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow();
  } finally { await directory.cleanup(); }
});

it('rejects invalid contributions before writing and drains accepted commits before closing', async () => {
  const directory = await temporaryDirectory(); const store = await SnapshotStore.open(directory.path);
  try {
    await store.transact(indexFixture); const before = store.capture().generation;
    await expect(store.transact((draft) => { draft.kv.fullEntities.set('doc-1', ['missing-entity']); })).rejects.toThrow('references');
    expect(store.capture().generation).toBe(before);
    const accepted = store.transact((draft) => { draft.kv.caches.set('closing', true); });
    const closing = store.close(); await accepted; await closing;
    await expect(store.transact(() => {})).rejects.toThrow('closing');
    const reopened = await SnapshotStore.open(directory.path);
    try { expect(reopened.capture().getKV('caches', 'closing')).toBe(true); }
    finally { await reopened.close(); }
  } finally { await store.close(); await directory.cleanup(); }
});

it('does not initialize a blank database over unrecognized pre-existing data', async () => {
  const directory = await temporaryDirectory();
  try {
    const file = join(directory.path, 'vdb_entities.json');
    await writeFile(file, '{"legacy":"preserve-me"}');
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow('explicit recovery required');
    expect(await readFile(file, 'utf8')).toBe('{"legacy":"preserve-me"}');
    expect(await readdir(join(workspace(directory.path), 'generations'))).toEqual([]);
  } finally { await directory.cleanup(); }
});
