import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function directory(path: string) {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Storage directory must not be a symlink');
  if (firstCreated) {
    let cursor = resolve(path);
    const stop = dirname(resolve(firstCreated));
    while (true) {
      await syncDirectory(cursor);
      if (cursor === stop) break;
      cursor = dirname(cursor);
    }
  }
}
export async function layout(dataDir: string) {
  const requested = resolve(dataDir); await directory(requested);
  const root = await realpath(requested);
  for (const relative of ['locks', 'locks/writer', 'workspace', 'workspace/default', 'workspace/default/generations']) await directory(join(root, relative));
  return { root, workspace: join(root, 'workspace/default'), generations: join(root, 'workspace/default/generations') };
}
export async function syncDirectory(path: string) {
  // Node cannot fsync directory handles on Windows. Still validate the path;
  // file fsync + same-volume rename provide process-crash recovery, not a
  // confirmed directory flush/power-loss guarantee on this platform.
  if (process.platform === 'win32') {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid storage directory');
    return false;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  return true;
}
export async function openRegular(path: string, flags = constants.O_RDONLY) {
  // O_NOFOLLOW is unavailable on Windows. Check reparse/symlink entries and
  // compare the opened identity on all platforms; never truncate before this.
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid storage file or symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !(flags & constants.O_CREAT)) throw error;
  }
  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const [entry, opened] = await Promise.all([lstat(path), handle.stat()]);
    if (!entry.isFile() || entry.isSymbolicLink() || !opened.isFile()
      || entry.dev !== opened.dev || entry.ino !== opened.ino) throw new Error('Storage file identity changed or symlink');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function writeNew(path: string, contents: string) {
  if (Buffer.byteLength(contents, 'utf8') > 256 * 1024 * 1024) throw new Error('Storage namespace exceeds 256 MiB');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
export async function readRegular(path: string) {
  const handle = await openRegular(path);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('Invalid or oversized storage file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
