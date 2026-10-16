import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function controlledDocuments(dataDir: string, checkpoint: 'before-parse' | 'after-parse' | 'before-final' | 'before-index-final' | 'before-maintenance-final' | 'after-maintenance-final') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/documents-process.mjs', import.meta.url)), dataDir, checkpoint], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; child.stdout.on('data', (b: Buffer) => { output += b.toString(); }); child.stderr.on('data', (b: Buffer) => { errors += b.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('exit', (code, signal) => { resolve({ code, signal }); }); child.once('error', reject); });
  const wait = async (event: string, jobId?: string) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      for (const line of output.split('\n')) if (line.startsWith('{')) {
        const value = JSON.parse(line) as { event: string; address: string; jobId?: string };
        if (value.event === event && (!jobId || jobId === value.jobId)) return value;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned documents fixture exited: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`Owned documents fixture timed out: ${errors}`);
  };
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    try { return await exit; } finally { clearTimeout(timer); }
  };
  try { const ready = await wait('listening'); return { address: ready.address, waitCheckpoint: (id: string) => wait('checkpoint', id), release: () => { child.stdin.write('release\n'); }, stop }; }
  catch (e) { await stop(); throw e; }
}
