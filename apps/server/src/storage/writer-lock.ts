import { constants } from 'node:fs';
import { join } from 'node:path';
import { flockSync } from 'fs-ext-extra-prebuilt';
import { openRegular } from './io.js';

export class WriterLock {
  private released = false;
  private constructor(private readonly handle: Awaited<ReturnType<typeof openRegular>>) {}
  get held() { return !this.released; }
  static async acquire(root: string) {
    // POSIX flock / Windows LockFileEx, held on the same persistent lease file.
    // Keeping flock on Linux also excludes older TsLightRAG writers.
    const handle = await openRegular(join(root, 'locks/writer/lease'), constants.O_RDWR | constants.O_CREAT);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Invalid writer lock file');
      try { flockSync(handle.fd, 'exnb'); }
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
