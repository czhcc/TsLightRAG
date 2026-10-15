import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { layout, readRegular, writeNew, syncDirectory } from './io.js';
import { WriterLock } from './writer-lock.js';
import { hasCurrent, loadCurrent, loadGeneration, publishPointer } from './disk.js';

/** Offline only: inspect and recover use the exact same kernel writer lock. */
export async function inspectStorage(dataDir: string, generation?: string) {
  const paths = await layout(dataDir); const lock = await WriterLock.acquire(paths.root);
  try {
    const loaded = generation ? await loadGeneration(paths, generation) : await loadCurrent(paths);
    return { generation: loaded.manifest.generation, revision: loaded.manifest.revision,
      corpusRevision: loaded.manifest.corpusRevision, previous: loaded.manifest.previous?.generation ?? null,
      validated: true, nodeCount: loaded.state.graph.nodeCount, edgeCount: loaded.state.graph.edgeCount };
  } finally { await lock.release(); }
}
export async function recoverStorage(dataDir: string, generation: string, confirmDataLoss: boolean) {
  if (!confirmDataLoss) throw new Error('Explicit --confirm-data-loss is required to restore a chosen generation');
  const paths = await layout(dataDir); const lock = await WriterLock.acquire(paths.root);
  try {
    const loaded = await loadGeneration(paths, generation);
    if (await hasCurrent(paths)) {
      await writeNew(join(paths.workspace, `recovery-backup-${randomUUID()}.json`), await readRegular(join(paths.workspace, 'CURRENT')));
      await syncDirectory(paths.workspace);
    }
    await publishPointer(paths, loaded.pointer);
    return { restoredGeneration: loaded.pointer.generation, revision: loaded.manifest.revision };
  } finally { await lock.release(); }
}
