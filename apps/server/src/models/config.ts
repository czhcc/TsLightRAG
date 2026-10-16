import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ModelSettingsSchema, SaveModelsSchema, TestModelSchema } from '@tslightrag/contracts';
import type { ModelProfileInput, ModelSettings } from '@tslightrag/contracts';
import { directory, syncDirectory, writeNew, readRegular } from '../storage/io.js';
import type { SnapshotStore, SnapshotView } from '../storage/snapshot.js';
import { modelUrl } from './url.js';
import { ModelError } from './errors.js';

const ConfigSchema = z.strictObject({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  ...SaveModelsSchema.shape,
}).omit({ expectedRevision: true });
export type ModelConfig = z.infer<typeof ConfigSchema> & { effectiveEmbeddingBinding?: {profileId:string;configRevision:number;spaceId:string} };
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
  private versions = new Map<number, ModelConfig>();
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
    const store = new ModelConfigStore(dir, config, storage, options.hook);
    store.versions.set(config.revision, structuredClone(config));
    await directory(join(dir, 'versions')); await chmod(join(dir, 'versions'), 0o700);
    const refs = new Set([storage.capture().indexBinding?.configRevision, ...storage.capture().jobs().filter((j) => ['queued','parsing','chunking','extracting','embedding','committing'].includes(j.status)).map((j) => j.configRevision)]);
    for (const revision of refs) if (revision !== undefined && revision !== config.revision) {
      try {
        const path = join(dir, 'versions', `${String(revision)}.json`);
        const stat = await lstat(path); if (stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error();
        const old = ConfigSchema.parse(JSON.parse(await readRegular(path)));
        if (old.revision !== revision) throw new Error(); store.versions.set(revision, old);
      } catch { throw new ModelError('CONFIG_REFERENCE_INVALID', '活动索引或任务引用的配置版本缺失或损坏', 503); }
    }
    const binding = storage.capture().indexBinding;
    if (binding) store.activeEmbedding();
    else {
      const space = (storage.capture().export()['vectors-chunks.json'] as {space:{id:string}|null;rows:unknown[]});
      const profile = boundProfile(config, 'embedding');
      if (space.rows.length && profile && embeddingSpaceId(profile) === space.space?.id) {
        await store.archive(); await storage.transact((draft) => { draft.indexBinding = {profileId:profile.id, configRevision:config.revision, spaceId:space.space!.id}; });
      }
    }
    return store;
  }
  get healthy() { return !this.fenced && !this.closed && this.storage.healthy; }
  private available() { if (!this.healthy) throw new ModelError('CONFIG_UNAVAILABLE', '配置不可用，请检查并重启', 503); }
  capture() { this.available(); return structuredClone(this.current); }
  revision(revision: number) {
    const value = this.versions.get(revision); if (!value) throw new ModelError('CONFIG_REFERENCE_INVALID', '配置版本不可用', 503); return structuredClone(value);
  }
  embeddingForSnapshot(view:SnapshotView) {
    const binding=view.indexBinding;
    if(!binding){const profile=boundProfile(this.capture(),'embedding');const vectors=view.export()['vectors-chunks.json'] as {space:{id:string}|null;rows:unknown[]};if(vectors.rows.length&&embeddingSpaceId(profile)!==vectors.space?.id)throw new ModelError('CONFIG_REFERENCE_INVALID','旧快照缺少匹配模型',503);return profile;}
    const profile=this.revision(binding.configRevision).profiles.find((p)=>p.id===binding.profileId);
    if(embeddingSpaceId(profile)!==binding.spaceId)throw new ModelError('CONFIG_REFERENCE_INVALID','活动模型与索引空间不匹配',503);
    return profile;
  }
  captureIndex(){const view=this.storage.capture();return {view,profile:this.embeddingForSnapshot(view)};}
  activeEmbedding(){return this.captureIndex().profile;}
  captureForIndex(): ModelConfig {
    const config = this.capture(); const binding = this.storage.capture().indexBinding;
    if (!binding) return config;
    const profile = this.activeEmbedding()!;
    config.effectiveEmbeddingBinding = binding;
    config.profiles = [...config.profiles.filter((p) => p.id !== profile.id), profile]; config.bindings.embedding = profile.id;
    return config;
  }
  bindingForIndex(config: ModelConfig) {
    const active = this.storage.capture().indexBinding; const profile = boundProfile(config, 'embedding'); const spaceId = embeddingSpaceId(profile);
    if (!profile || !spaceId) throw new ModelError('MODEL_NOT_CONFIGURED', '缺少向量模型', 409);
    return config.effectiveEmbeddingBinding?.spaceId === spaceId ? config.effectiveEmbeddingBinding : active?.spaceId === spaceId ? active : {profileId:profile.id,configRevision:config.revision,spaceId};
  }
  public() {
    const value = publicConfig(this.capture()); const binding = this.storage.capture().indexBinding;
    if (binding) { const profile = this.activeEmbedding()!; const {apiKey, ...fields} = profile;
      value.activeIndex = {spaceId:binding.spaceId,configRevision:binding.configRevision,profile:{...fields,hasApiKey:Boolean(apiKey)}};
    } else value.activeIndex = null;
    return value;
  }
  private async archive() {
    await directory(this.dir); const dir=join(this.dir,'versions'); await directory(dir);
    const path=join(dir,`${String(this.current.revision)}.json`);const text=JSON.stringify(this.current);const temporary=join(dir,`.version-${randomUUID()}.tmp`);
    try {
      await writeNew(temporary,text);
      try {await link(temporary,path);}catch(error){
        if(!(error instanceof Error&&'code' in error&&error.code==='EEXIST')||await readRegular(path)!==text)throw new ModelError('CONFIG_ARCHIVE_FAILED','配置版本保存失败，未更改配置',500);
      }
      await syncDirectory(dir);
    } catch {throw new ModelError('CONFIG_ARCHIVE_FAILED','配置版本保存失败，未更改配置',500);}
    finally {await rm(temporary,{force:true}).catch(()=>{});}
  }
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
      const active = this.storage.capture().indexBinding;
      const protectedIds = new Set(active ? [active.profileId] : []);
      for (const job of this.storage.capture().jobs()) if (['queued','parsing','chunking','extracting','embedding','committing'].includes(job.status)) {
        const captured = this.revision(job.configRevision); for (const id of Object.values(captured.bindings)) if (id) protectedIds.add(id);
        if (job.maintenance?.targetProfileId) protectedIds.add(job.maintenance.targetProfileId);
      }
      for (const id of protectedIds) if (!next.profiles.some((p) => p.id === id)) throw new ModelError('PROFILE_IN_USE', '活动索引或任务仍在引用该模型，请先切换或结束任务', 409);
      if(active&&next.profiles.find((p)=>p.id===active.profileId)?.kind!=='embedding')throw new ModelError('PROFILE_IN_USE','活动向量模型不能改成其他类型',409);
      const legacy = this.storage.capture().export()['vectors-chunks.json'] as {rows:unknown[]};
      if (legacy.rows.length && !active) throw new ModelError('REBUILD_REQUIRED', '旧索引缺少有效模型绑定，需先恢复模型配置', 409);
      await this.archive();
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
        await rename(temporary, target); published = true; this.current = next; this.versions.set(next.revision, structuredClone(next));
        await this.hook?.('after-rename'); await syncDirectory(this.dir);
        return this.public();
      } catch {
        if (published) { this.fenced = true; throw new ModelError('CONFIG_PUBLISHED_UNCERTAIN', '配置已发布，但同步未确认；请检查并重启，勿盲目重试', 503); }
        throw new ModelError('CONFIG_WRITE_FAILED', '模型配置保存失败，原配置未更改', 500);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.tail = work.then(() => {}, () => {}); return work;
  }
  async close() { this.closing = true; await this.tail; this.closed = true; }
}
