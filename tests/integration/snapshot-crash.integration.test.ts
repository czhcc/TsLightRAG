import { expect, it } from 'vitest';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { FILE_NAMES } from '../../apps/server/src/storage/state.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { indexFixture } from '../helpers/indexed-state.js';
import { storageProcess } from '../helpers/storage-process.js';

const checkpoints = [...FILE_NAMES.map((file) => `after-namespace:${file}`), 'after-manifest', 'before-current', 'after-current', 'after-current-sync'];
it.each(checkpoints)('survives actual SIGKILL at %s with one complete old/new generation', async (checkpoint) => {
  const directory = await temporaryDirectory(); const baseline = await SnapshotStore.open(directory.path);
  try { await baseline.transact(indexFixture); } finally { await baseline.close(); }
  const process = storageProcess(directory.path, 'crash', checkpoint);
  try {
    await process.wait('checkpoint');
    expect((await process.stop('SIGKILL')).signal).toBe('SIGKILL');
    const store = await SnapshotStore.open(directory.path);
    try {
      const snapshot = store.capture();
      const expected = checkpoint === 'after-current' || checkpoint === 'after-current-sync' ? 'new' : 'old';
      expect(snapshot.getKV('caches', 'marker')).toBe(expected);
      expect(snapshot.document('doc-1')?.name).toBe(expected);
      expect(snapshot.getKV('fullDocs', 'doc-1')).toMatchObject({ name: expected });
      expect(snapshot.node('e1')?.description).toBe(expected);
      const relation = snapshot.edge('e1', 'e2'); expect(relation).toBeDefined();
      for (const [namespace, id] of [['chunks', 'c1'], ['entities', 'e1'], ['relations', relation?.id ?? 'missing']] as const) {
        expect(snapshot.getVector(namespace, id)?.metadata.marker).toBe(expected);
      }
      expect(snapshot.corpusRevision).toBe(expected === 'old' ? 1 : 2);
    } finally { await store.close(); }
  } finally { await process.stop('SIGKILL'); await directory.cleanup(); }
});
