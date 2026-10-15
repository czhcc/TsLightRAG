import { expect, it } from 'vitest';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { ModelConfigStore } from '../../apps/server/src/models/config.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { storageProcess } from '../helpers/storage-process.js';
import { textProfile } from '../helpers/model-profiles.js';

it.each(['before-rename', 'after-rename'])('config survives real SIGKILL at %s with one complete revision', async (point) => {
  const directory = await temporaryDirectory();
  const seed = await SnapshotStore.open(directory.path); const config = await ModelConfigStore.open(directory.path, seed);
  await config.save({ expectedRevision: 0, profiles: [textProfile('http://127.0.0.1:7777/v1')], bindings: { query: 'text', extract: null, keyword: null, embedding: null, rerank: null } });
  await config.close(); await seed.close();
  const process = storageProcess(directory.path, 'config', point);
  try {
    await process.wait('checkpoint'); expect((await process.stop('SIGKILL')).signal).toBe('SIGKILL');
    const storage = await SnapshotStore.open(directory.path);
    const reopened = await ModelConfigStore.open(directory.path, storage);
    try {
      const state = reopened.capture(); const published = point === 'after-rename';
      expect(state.revision).toBe(published ? 2 : 1);
      expect(state.profiles[0]?.model).toBe(published ? 'new-model' : 'text-model');
      expect(state.profiles[0]?.apiKey).toBe(published ? 'new-synthetic-key' : 'synthetic-s03-secret');
      expect(reopened.public().profiles[0]?.hasApiKey).toBe(true); expect(storage.capture().revision).toBe(0);
    } finally { await reopened.close(); await storage.close(); }
  } finally { await process.stop('SIGKILL'); await directory.cleanup(); }
});
