import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../fixtures/storage-process.mjs', import.meta.url));
export function storageProcess(dataDir: string, mode: 'hold' | 'crash', checkpoint = '') {
  const child = spawn(process.execPath, [fixture, dataDir, mode, checkpoint], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', (value: Buffer) => { output += value.toString(); });
  child.stderr.on('data', (value: Buffer) => { errors += value.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject); child.on('exit', (code, signal) => { resolve({ code, signal }); });
  });
  return { child,
    wait: async (event: 'ready' | 'checkpoint') => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (output.includes(`"event":"${event}"`)) return;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`Fixture ${event} timed out: ${errors}`);
    },
    stop: async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 4000);
      try { return await exit; } finally { clearTimeout(timer); }
    },
  };
}
