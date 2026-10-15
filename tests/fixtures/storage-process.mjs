import { SnapshotStore } from '../../apps/server/dist/storage/snapshot.js';

const [dataDir, mode, checkpoint] = process.argv.slice(2);
let armed = false;
const keepAlive = setInterval(() => {}, 1000);
const store = await SnapshotStore.open(dataDir, { hook: async (point, file) => {
  if (armed && (point === checkpoint || `${point}:${file}` === checkpoint)) {
    process.stdout.write(`${JSON.stringify({ event: 'checkpoint', point, file })}\n`);
    await new Promise(() => {});
  }
} });
process.stdout.write(`${JSON.stringify({ event: 'ready', generation: store.capture().generation })}\n`);
process.once('SIGTERM', () => { void store.close().then(() => { clearInterval(keepAlive); }); });
if (mode === 'crash') {
  armed = true;
  await store.transact((draft) => {
    const doc = draft.documents.get('doc-1'); if (!doc) throw new Error('Missing fixture document');
    draft.documents.set('doc-1', { ...doc, name: 'new' });
    const full = draft.kv.fullDocs.get('doc-1'); draft.kv.fullDocs.set('doc-1', { ...full, name: 'new' });
    const node = draft.graph.getNode('e1'); if (!node) throw new Error('Missing fixture entity');
    draft.graph.setNode({ ...node, description: 'new' });
    for (const name of ['chunks', 'entities', 'relations']) {
      for (const row of draft.vectors[name].serialize().rows) {
        draft.vectors[name].set({ ...row, values: [0, 1], metadata: { marker: 'new' } }, 'space-v1');
      }
    }
    draft.kv.caches.set('marker', 'new');
  });
  process.stdout.write('unexpected-completion\n');
  await store.close(); clearInterval(keepAlive);
}

if (mode === 'config') {
  const { ModelConfigStore } = await import('../../apps/server/dist/models/config.js');
  const config = await ModelConfigStore.open(dataDir, store, { hook: async (point) => {
    if (point === checkpoint) {
      process.stdout.write(`${JSON.stringify({ event: 'checkpoint', point })}\n`);
      await new Promise(() => {});
    }
  } });
  const previous = config.capture();
  await config.save({ expectedRevision: previous.revision, bindings: previous.bindings,
    profiles: previous.profiles.map((profile) => ({ ...profile, model: 'new-model', apiKey: 'new-synthetic-key' })) });
  process.stdout.write('unexpected-completion\n');
  await config.close(); await store.close(); clearInterval(keepAlive);
}
