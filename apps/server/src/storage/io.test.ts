import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { expect, it } from 'vitest';
import { directory } from './io.js';

it('finishes syncing newly created nested directories with native mkdir paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tslightrag-directory-'));
  try {
    const target = join(root, 'new', 'nested', 'directory');
    await directory(target);
    expect((await stat(target)).isDirectory()).toBe(true);
    await directory(target);
    await directory(toNamespacedPath(join(root, 'other', 'nested')));
    expect((await stat(join(root, 'other', 'nested'))).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
