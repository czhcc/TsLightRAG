import { SnapshotStore } from '../../apps/server/dist/storage/snapshot.js';
import { buildApp } from '../../apps/server/dist/app.js';
const [dataDir, checkpoint] = process.argv.slice(2);
const storage = await SnapshotStore.open(dataDir);
let release = () => {};
process.stdin.on('data', () => { release(); });
const app = await buildApp({ storage, documentOptions: { hook: async (point, job, signal) => {
  if (point !== checkpoint || job.attempt !== 1) return;
  process.stdout.write(`${JSON.stringify({ event: 'checkpoint', point, jobId: job.id })}\n`);
  await new Promise((resolve) => { release = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
} } });
await app.listen({ host: '127.0.0.1', port: 0 });
process.stdout.write(`${JSON.stringify({ event: 'listening', address: app.listeningOrigin })}\n`);
process.on('SIGTERM', () => { void app.close().then(() => storage.close()).then(() => { process.stdin.destroy(); }); });
