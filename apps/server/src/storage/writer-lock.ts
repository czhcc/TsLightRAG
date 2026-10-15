import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import fsExt from 'fs-ext';

export class WriterLock {
  private released = false;
  private constructor(private readonly handle: Awaited<ReturnType<typeof open>>) {}
  get held() { return !this.released; }
  static async acquire(root: string) {
    if (process.platform !== 'linux') throw new Error('S02 file storage requires Linux local filesystem');
    const handle = await open(join(root, 'locks/writer/lease'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Invalid writer lock file');
      try { fsExt.flockSync(handle.fd, 'exnb'); }
      catch (error) {
        if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw new Error('STORAGE_LOCKED: another writer owns this data directory', { cause: error });
        }
        throw new Error('Kernel file locking unavailable; refusing to write', { cause: error });
      }
      await handle.truncate(0);
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      await handle.sync();
      return new WriterLock(handle);
    } catch (error) { await handle.close(); throw error; }
  }
  async release() {
    if (this.released) return;
    this.released = true;
    // Keep the inode forever: unlinking a lease can create two independent locks.
    await this.handle.close();
  }
}
