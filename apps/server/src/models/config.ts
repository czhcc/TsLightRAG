import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ModelSettingsSchema, SaveModelsSchema, TestModelSchema } from '@tslightrag/contracts';
import type { ModelProfileInput, ModelSettings } from '@tslightrag/contracts';
import { directory, syncDirectory, writeNew } from '../storage/io.js';
import type { SnapshotStore } from '../storage/snapshot.js';
import { modelUrl } from './url.js';
import { ModelError } from './errors.js';

const ConfigSchema = z.strictObject({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  ...SaveModelsSchema.shape,
}).omit({ expectedRevision: true });
export type ModelConfig = z.infer<typeof ConfigSchema>;
export type PrivateProfile = ModelProfileInput;
const empty: ModelConfig = { schemaVersion: 1, revision: 0, profiles: [],
  bindings: { query: null, extract: null, keyword: null, embedding: null, rerank: null } };
export function boundProfile(config: ModelConfig, role: keyof ModelConfig['bindings']) {
  const id = config.bindings[role] ?? (role === 'extract' || role === 'keyword' ? config.bindings.query : null);
  return config.profiles.find((p) => p.id === id);
}
export function embeddingSpaceId(profile: PrivateProfile | undefined) {
  if (!profile || profile.kind !== 'embedding') return null;
  return createHash('sha256').update(JSON.stringify([profile.protocol, modelUrl(profile.endpoint, 'embedding').href,
    profile.model, profile.dimensions, 'l2', profile.operatorRevision])).digest('hex');
}
function publicConfig(config: ModelConfig): ModelSettings {
  return ModelSettingsSchema.parse({ revision: config.revision, editingAvailable: true,
    profiles: config.profiles.map(({ apiKey, ...p }) => ({ ...p, hasApiKey: Boolean(apiKey) })),
    bindings: config.bindings, embeddingSpaceId: embeddingSpaceId(boundProfile(config, 'embedding')) });
}
function validate(config: ModelConfig) {
  for (const p of config.profiles) modelUrl(p.endpoint, p.kind);
  publicConfig(config); return config;
}

/** Owns the config serial queue; the caller must retain SnapshotStore's writer lease. */
export class ModelConfigStore {
  private tail: Promise<void> = Promise.resolve();
  private fenced = false;
  private closing = false;
  private closed = false;
  private constructor(private readonly dir: string, private current: ModelConfig,
    private readonly storage: SnapshotStore, private readonly hook?: (point: 'before-rename' | 'after-rename') => Promise<void>) {}
  static async open(dataDir: string, storage: SnapshotStore, options: { hook?: (point: 'before-rename' | 'after-rename') => Promise<void> } = {}) {
    if (!storage.healthy) throw new ModelError('CONFIG_UNAVAILABLE', '存储锁不可用', 503);
    const dir = join(dataDir, 'config'); await directory(dir); await chmod(dir, 0o700);
    const path = join(dir, 'app.json'); let config = structuredClone(empty);
    try {
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink()) throw new Error('Symlink');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new Error();
        config = validate(ConfigSchema.parse(JSON.parse(await handle.readFile('utf8'))));
      } finally { await handle.close(); }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new ModelError('CONFIG_CORRUPT', '本地模型配置损坏或权限不安全；未覆盖配置', 503);
    }
    return new ModelConfigStore(dir, config, storage, options.hook);
  }
  get healthy() { return !this.fenced && !this.closed && this.storage.healthy; }
  private available() { if (!this.healthy) throw new ModelError('CONFIG_UNAVAILABLE', '配置不可用，请检查并重启', 503); }
  capture() { this.available(); return structuredClone(this.current); }
  public() { return publicConfig(this.capture()); }
  candidate(input: unknown) {
    this.available();
    const parsed = TestModelSchema.safeParse(input);
    if (!parsed.success) throw new ModelError('INVALID_CONFIG', '模型配置不合法', 400);
    if (parsed.data.expectedRevision !== this.current.revision) throw new ModelError('REVISION_CONFLICT', '配置已更新，请重新加载', 409);
    return this.mergeKey(parsed.data.profile);
  }
  private mergeKey(profile: PrivateProfile): PrivateProfile {
    const old = this.current.profiles.find((p) => p.id === profile.id);
    const key = profile.apiKey === undefined ? old?.apiKey : profile.apiKey;
    const result = { ...profile, apiKey: key ?? null };
    modelUrl(result.endpoint, result.kind);
    // Retained keys are scoped to the same target. Editing the address needs an
    // explicit replacement/clear, so a candidate cannot forward a saved key elsewhere.
    if (profile.apiKey === undefined && old?.apiKey && modelUrl(old.endpoint, old.kind).href !== modelUrl(profile.endpoint, profile.kind).href) {
      throw new ModelError('KEY_TARGET_CHANGED', '地址变更后请重新输入或清除密钥', 409);
    }
    return result;
  }
  /** Final index publication and config replacement share this queue, preventing a space switch race. */
  withRevision<T>(revision: number, work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.available();
      if (this.current.revision !== revision) throw new ModelError('CONFIG_CHANGED', '配置已变化，请手动重试', 409);
      return work();
    });
    this.tail = result.then(() => {}, () => {}); return result;
  }
  save(input: unknown) {
    if (this.closing) return Promise.reject(new ModelError('CONFIG_UNAVAILABLE', '配置正在关闭', 503));
    const work = this.tail.then(async () => {
      this.available();
      const parsed = SaveModelsSchema.safeParse(input);
      if (!parsed.success) throw new ModelError('INVALID_CONFIG', '模型配置不合法', 400);
      if (parsed.data.expectedRevision !== this.current.revision) throw new ModelError('REVISION_CONFLICT', '配置已更新，请重新加载', 409);
      const next = validate({ schemaVersion: 1, revision: this.current.revision + 1,
        profiles: parsed.data.profiles.map((p) => this.mergeKey(p)), bindings: parsed.data.bindings });
      const view = this.storage.capture().export();
      const indexed = view['vectors-chunks.json'] as { rows: unknown[] };
      if (indexed.rows.length) {
        const active = (view['vectors-chunks.json'] as { space: { id: string } }).space.id;
        if (embeddingSpaceId(boundProfile(next, 'embedding')) !== active) throw new ModelError('REBUILD_REQUIRED', '非空索引的向量空间切换需要 S07 重建流程', 409);
        // S07 will replace this conservative guard with generation/task references.
        if (JSON.stringify(this.current.profiles) !== JSON.stringify(next.profiles)) throw new ModelError('REBUILD_REQUIRED', '非空索引暂不允许修改或删除模型凭据，需重建流程', 409);
      }
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > 1024 * 1024) throw new ModelError('INVALID_CONFIG', '模型配置超过文件大小限制', 413);
      const temporary = join(this.dir, `.app-${randomUUID()}.tmp`); let published = false;
      try {
        await writeNew(temporary, serialized);
        await this.hook?.('before-rename');
        const target = join(this.dir, 'app.json');
        try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink'); } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        await rename(temporary, target); published = true; this.current = next;
        await this.hook?.('after-rename'); await syncDirectory(this.dir);
        return publicConfig(next);
      } catch {
        if (published) { this.fenced = true; throw new ModelError('CONFIG_PUBLISHED_UNCERTAIN', '配置已发布，但同步未确认；请检查并重启，勿盲目重试', 503); }
        throw new ModelError('CONFIG_WRITE_FAILED', '模型配置保存失败，原配置未更改', 500);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.tail = work.then(() => {}, () => {}); return work;
  }
  async close() { this.closing = true; await this.tail; this.closed = true; }
}
