import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'tslightrag-test-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
