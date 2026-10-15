import { buildApp } from './app.js';
import { help, parseStartup } from './cli.js';
import { SnapshotStore } from './storage/snapshot.js';

try {
  const options = await parseStartup(process.argv.slice(2));
  if (!options) {
    process.stdout.write(help);
  } else {
    const storage = await SnapshotStore.open(options.dataDir);
    let app;
    try {
      app = await buildApp({ storage });
      await app.listen({ host: options.host, port: options.port });
    } catch (error) {
      if (app) await app.close();
      await storage.close();
      throw error;
    }
    const address = app.listeningOrigin;
    // One machine-readable line for owned-process startup and readiness tests.
    process.stdout.write(`${JSON.stringify({ event: 'listening', address, dataDir: options.dataDir, stage: 'S02' })}\n`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await app.close(); } finally { await storage.close(); }
    };
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
  }
} catch (error) {
  // CLI validation errors are deliberately sanitized in parseStartup.
  const message = error instanceof Error ? error.message : '启动失败';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
