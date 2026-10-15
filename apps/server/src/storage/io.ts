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
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function writeNew(path: string, contents: string) {
  if (Buffer.byteLength(contents, 'utf8') > 256 * 1024 * 1024) throw new Error('Storage namespace exceeds 256 MiB');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
export async function readRegular(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('Invalid or oversized storage file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
