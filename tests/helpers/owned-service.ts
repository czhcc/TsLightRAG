import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './temporary-directory.js';

const main = fileURLToPath(new URL('../../apps/server/dist/main.js', import.meta.url));

export async function startService(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const directory = await temporaryDirectory();
  const child = spawn(process.execPath, [main, '--port', '0', '--data-dir', directory.path, ...args], {
    cwd: directory.path, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (value: Buffer) => { output += value.toString(); });
  child.stderr.on('data', (value: Buffer) => { errors += value.toString(); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('exit', (code) => { resolve(code); });
    child.once('error', reject);
  });
  async function stop() {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return await exit;
    } finally {
      clearTimeout(timer);
      await directory.cleanup();
    }
  }
  try {
    const deadline = Date.now() + (process.platform === 'win32' ? 40_000 : 10_000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Service exited: ${errors}`);
      const line = output.split('\n').find((item) => item.startsWith('{'));
      if (line) {
        const event = JSON.parse(line) as { address: string; dataDir: string };
        return { address: event.address, dataDir: event.dataDir, child, stop };
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Owned service readiness timeout: ${errors}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
