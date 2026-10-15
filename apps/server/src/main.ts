import { buildApp } from './app.js';
import { help, parseStartup } from './cli.js';

try {
  const options = await parseStartup(process.argv.slice(2));
  if (!options) {
    process.stdout.write(help);
  } else {
    const app = await buildApp();
    const address = await app.listen({ host: options.host, port: options.port });
    // One machine-readable line for owned-process startup and readiness tests.
    process.stdout.write(`${JSON.stringify({ event: 'listening', address, dataDir: options.dataDir, stage: 'S01' })}\n`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
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
