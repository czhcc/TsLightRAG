import { afterEach, expect, it } from 'vitest';
import { readFile, stat, writeFile, symlink, chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelConfigStore, boundProfile, embeddingSpaceId } from './config.js';
import { SnapshotStore } from '../storage/snapshot.js';
import { temporaryDirectory } from '../../../../tests/helpers/temporary-directory.js';
import { textProfile, embeddingProfile } from '../../../../tests/helpers/model-profiles.js';
import { indexFixture } from '../../../../tests/helpers/indexed-state.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(hook?: (point: 'before-rename' | 'after-rename') => Promise<void>) {
  const dir = await temporaryDirectory(); cleanup.push(dir.cleanup);
  const storage = await SnapshotStore.open(dir.path); cleanup.push(() => storage.close());
  const config = await ModelConfigStore.open(dir.path, storage, hook ? { hook } : {}); cleanup.push(() => config.close());
  return { dir: dir.path, storage, config };
}
const input = () => ({ expectedRevision: 0, profiles: [textProfile('http://127.0.0.1:7777/v1'), embeddingProfile('http://localhost:7778/v1')],
  bindings: { query: 'text', extract: null, keyword: null, embedding: 'embedding', rerank: null } });
it('starts unconfigured, persists versioned private config and restores masked profiles', async () => {
  const { dir, storage, config } = await fixture(); expect(config.public().profiles).toEqual([]);
  const saved = await config.save(input()); expect(saved.revision).toBe(1); expect(saved.profiles[0]?.hasApiKey).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('synthetic-s03-secret'); expect(JSON.stringify(saved)).not.toContain('apiKey');
  expect((await stat(join(dir, 'config'))).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, 'config/app.json'))).mode & 0o777).toBe(0o600);
  const restored = await ModelConfigStore.open(dir, storage); cleanup.push(() => restored.close());
  expect(restored.public()).toEqual(saved); expect(restored.capture().profiles[0]?.apiKey).toBe('synthetic-s03-secret');
  expect(boundProfile(restored.capture(), 'extract')?.id).toBe('text'); expect(boundProfile(restored.capture(), 'keyword')?.id).toBe('text');
});
it('implements omit/null/string keys without returning secrets and detaches captures', async () => {
  const { config } = await fixture(); const p = input(); await config.save(p);
  delete p.profiles[0]?.apiKey; p.expectedRevision = 1; await config.save(p);
  expect(config.capture().profiles[0]?.apiKey).toBe('synthetic-s03-secret');
  const copy = config.capture(); copy.profiles[0]!.apiKey = 'external-change'; expect(config.capture().profiles[0]?.apiKey).toBe('synthetic-s03-secret');
  p.profiles[0]!.apiKey = null; p.expectedRevision = 2; expect((await config.save(p)).profiles[0]?.hasApiKey).toBe(false);
  p.profiles[0]!.apiKey = 'replacement'; p.expectedRevision = 3; await config.save(p); expect(config.capture().profiles[0]?.apiKey).toBe('replacement');
});
it('serializes competing revisions with one winner and validates references', async () => {
  const { config } = await fixture();
  const results = await Promise.allSettled([config.save(input()), config.save(input())]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1); expect(config.public().revision).toBe(1);
  await expect(config.save({ ...input(), expectedRevision: 1, bindings: { ...input().bindings, embedding: 'text' } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
});
it('rejects masked placeholders, unsafe URLs and malformed input without secret-bearing errors', async () => {
  const { config } = await fixture();
  for (const patch of [{ apiKey: '******' }, { endpoint: 'http://169.254.169.254' }, { apiKey: 'key\nAuthorization: bad' }]) {
    const p = input(); Object.assign(p.profiles[0]!, patch); await expect(config.save(p)).rejects.toBeInstanceOf(Error);
  }
  expect(config.public().revision).toBe(0);
});
it('keeps old revision/file on pre-publication failure and permits an explicit retry', async () => {
  let fail = false;
  const { config, dir } = await fixture(async (point) => { if (fail && point === 'before-rename') throw new Error('synthetic-secret'); });
  await config.save(input()); const original = await readFile(join(dir, 'config/app.json'), 'utf8'); fail = true;
  await expect(config.save({ ...input(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'CONFIG_WRITE_FAILED' });
  expect(await readFile(join(dir, 'config/app.json'), 'utf8')).toBe(original); expect(config.public().revision).toBe(1);
  fail = false; expect((await config.save({ ...input(), expectedRevision: 1 })).revision).toBe(2);
});
it('fences after publication uncertainty; restart reads the published revision', async () => {
  const { config, storage, dir } = await fixture(async () => {});
  await config.close();
  const failing = await ModelConfigStore.open(dir, storage, { hook: async (p) => { if (p === 'after-rename') throw new Error(); } }); cleanup.push(() => failing.close());
  await expect(failing.save(input())).rejects.toMatchObject({ code: 'CONFIG_PUBLISHED_UNCERTAIN' }); expect(failing.healthy).toBe(false);
  const reopened = await ModelConfigStore.open(dir, storage); cleanup.push(() => reopened.close()); expect(reopened.public().revision).toBe(1);
});
it('refuses corrupted config, insecure permissions and symlinks without overwriting them', async () => {
  const { config, storage, dir } = await fixture(); await config.save(input()); const path = join(dir, 'config/app.json');
  await chmod(path, 0o644); await expect(ModelConfigStore.open(dir, storage)).rejects.toMatchObject({ code: 'CONFIG_CORRUPT' });
  await chmod(path, 0o600); await writeFile(path, '{broken-private-secret'); await expect(ModelConfigStore.open(dir, storage)).rejects.toMatchObject({ code: 'CONFIG_CORRUPT' });
  expect(await readFile(path, 'utf8')).toBe('{broken-private-secret');
  await rm(path); await symlink(join(dir, 'missing-secret'), path);
  await expect(ModelConfigStore.open(dir, storage)).rejects.toMatchObject({ code: 'CONFIG_CORRUPT' });
});
it('candidate testing preserves save revision and requires explicit key handling for a changed target', async () => {
  const { config } = await fixture(); await config.save(input()); const p = input().profiles[0]!; delete p.apiKey;
  expect(config.candidate({ expectedRevision: 1, profile: p }).apiKey).toBe('synthetic-s03-secret');
  p.endpoint = 'http://127.0.0.1:9000/v1'; expect(() => config.candidate({ expectedRevision: 1, profile: p })).toThrow('密钥');
  p.apiKey = null; expect(config.candidate({ expectedRevision: 1, profile: p }).apiKey).toBeNull(); expect(config.public().revision).toBe(1);
  expect(() => config.candidate({ expectedRevision: 0, profile: p })).toThrow('重新加载');
});
it('embedding identity includes endpoint/model/dimensions/operator revision, excludes keys and canonicalizes slashes', () => {
  const p = embeddingProfile('http://localhost/v1/'); const id = embeddingSpaceId(p);
  expect(embeddingSpaceId({ ...p, endpoint: 'http://localhost/v1', apiKey: 'different' })).toBe(id);
  for (const patch of [{ model: 'different' }, { dimensions: 3 }, { operatorRevision: 1 }, { endpoint: 'http://localhost/other/v1' }]) expect(embeddingSpaceId({ ...p, ...patch })).not.toBe(id);
});
it('blocks nonempty embedding space changes until rebuild exists', async () => {
  const { storage, config } = await fixture(); await storage.transact((draft) => { indexFixture(draft); });
  await expect(config.save(input())).rejects.toMatchObject({ code: 'REBUILD_REQUIRED' }); expect(config.public().revision).toBe(0);
});

it('actual filesystem rename failure cannot report success and can be retried after repair', async () => {
  const { config, dir } = await fixture(); const target = join(dir, 'config/app.json');
  await mkdir(target); // rename(file, directory) fails for root as well as ordinary users.
  await expect(config.save(input())).rejects.toMatchObject({ code: 'CONFIG_WRITE_FAILED' });
  expect(config.public().revision).toBe(0); expect((await stat(target)).isDirectory()).toBe(true);
  await rm(target, { recursive: true }); expect((await config.save(input())).revision).toBe(1);
});
it('close drains an accepted save and rejects later writes', async () => {
  const { config } = await fixture(); const save = config.save(input()); const close = config.close();
  expect((await save).revision).toBe(1); await close;
  await expect(config.save(input())).rejects.toMatchObject({ code: 'CONFIG_UNAVAILABLE' });
});
