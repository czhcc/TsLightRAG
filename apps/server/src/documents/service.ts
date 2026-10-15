import { randomUUID } from 'node:crypto';
import { ImportTextSchema } from '@tslightrag/contracts';
import type { DocumentRecord, JobRecord } from '@tslightrag/contracts';
import { prepareDocument } from '../parsers/index.js';
import { formatOf, ParserError } from '../parsers/common.js';
import { boundProfile } from '../models/config.js';
import type { ModelConfigStore } from '../models/config.js';
import { PublishedCommitError } from '../storage/snapshot.js';
import type { SnapshotStore } from '../storage/snapshot.js';
import { JsonSchema } from '../storage/kv.js';
import type { WorkspaceDraft } from '../storage/state.js';
import { DocumentError, DocumentFiles, digest } from './files.js';

export interface DocumentServiceOptions { hook?: (point: 'before-parse' | 'after-parse' | 'before-final', job: JobRecord, signal: AbortSignal) => Promise<void> }
const executing = new Set(['queued', 'parsing', 'chunking', 'extracting', 'embedding', 'committing']);
const retryable = new Set(['failed', 'cancelled', 'interrupted', 'awaiting_configuration', 'awaiting_indexing']);
const now = () => new Date().toISOString();
export class DocumentService {
  private closing = false;
  private broken = false;
  private admission: Promise<void> = Promise.resolve();
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private scheduled = false;
  private constructor(private readonly storage: SnapshotStore, private readonly config: ModelConfigStore,
    readonly files: DocumentFiles, private readonly options: DocumentServiceOptions) {}
  static async open(storage: SnapshotStore, config: ModelConfigStore, options: DocumentServiceOptions = {}) {
    const files = new DocumentFiles(storage.dataDir); await files.initialize();
    const service = new DocumentService(storage, config, files, options);
    for (const doc of storage.capture().documents()) if (doc.ingestion) await files.source(doc);
    for (const job of storage.capture().jobs()) if (job.result && job.documentId) {
      const doc = storage.capture().document(job.documentId); if (!doc) throw new DocumentError('JOB_INVALID', '任务文档缺失', 503);
      await files.artifact(job, doc);
    }
    if (storage.capture().jobs().some((job) => executing.has(job.status))) await storage.transact((draft) => {
      for (const [, job] of draft.jobs.entries()) if (executing.has(job.status)) service.update(draft, job, {
        status: job.cancelRequested ? 'cancelled' : 'interrupted', phase: job.cancelRequested ? 'cancelled' : 'interrupted',
        error: job.cancelRequested ? null : '服务重启中断任务；请手动重试', errorCode: job.cancelRequested ? 'CANCELLED' : 'INTERRUPTED',
      });
    });
    return service;
  }
  get healthy() { return !this.closing && !this.broken && this.storage.healthy; }
  private check() { if (!this.healthy) throw new DocumentError('JOBS_UNAVAILABLE', '任务服务正在关闭或存储不可用', 503); }
  private update(draft: WorkspaceDraft, previous: JobRecord, patch: Partial<JobRecord>) {
    const job = { ...previous, ...patch, updatedAt: now() }; draft.jobs.set(job.id, job);
    if (job.documentId) {
      const doc = draft.documents.get(job.documentId);
      if (doc?.ingestion?.latestJobId === job.id) {
        const next = { ...doc, status: job.status, updatedAt: job.updatedAt }; draft.documents.set(doc.id, next);
        const stored = draft.kv.fullDocs.get(doc.id); draft.kv.fullDocs.set(doc.id, JsonSchema.parse({ ...stored as object, ...next }));
      }
    }
    return job;
  }
  private serial<T>(work: () => Promise<T>) {
    if (this.closing) return Promise.reject(new DocumentError('JOBS_UNAVAILABLE', '任务服务正在关闭', 503));
    const result = this.admission.then(async () => { this.check(); return work(); });
    this.admission = result.then(() => {}, () => {});
    return result.catch((error: unknown) => {
      if (error instanceof PublishedCommitError) throw new DocumentError('DOCUMENT_PUBLISHED_UNCERTAIN', '文档记录已发布，但同步未确认；请检查并重启，勿盲目重试', 503);
      throw error;
    });
  }
  private capacity() {
    const view = this.storage.capture();
    if (view.jobs().filter((j) => executing.has(j.status)).length >= 10) throw new DocumentError('JOB_QUEUE_FULL', '处理队列已满，请稍后再导入', 429);
    if (view.jobs().length >= 5000) throw new DocumentError('JOB_LIMIT', '任务记录达到 5000 项上限', 413);
  }
  private newJob(doc: DocumentRecord, previous?: JobRecord): JobRecord {
    const config = this.config.capture(); const text = boundProfile(config, 'query');
    return { id: `j-${randomUUID()}`, documentId: doc.id, operation: 'index', status: 'queued', phase: 'queued',
      attempt: (previous?.attempt ?? 0) + 1, ...(previous ? { previousJobId: previous.id } : {}),
      configRevision: config.revision, cancelRequested: false, error: null, updatedAt: now(), createdAt: now(), warnings: [],
      preparation: { encoding: text?.kind === 'text' ? text.tokenizer : 'cl100k_base',
        missingRoles: (['query', 'embedding'] as const).filter((role) => !boundProfile(config, role)),
        configIdentity: digest(JSON.stringify(this.config.public())) },
    };
  }
  importText(input: unknown) {
    const parsed = ImportTextSchema.safeParse(input);
    if (!parsed.success || !parsed.data.text.trim()) return Promise.reject(new DocumentError('INVALID_DOCUMENT', '名称和文本不能为空或超限', 400));
    const format = formatOf(parsed.data.name);
    if (!['txt', 'md'].includes(format)) return Promise.reject(new DocumentError('INVALID_TEXT_FORMAT', '粘贴文本仅支持 TXT 或 Markdown', 400));
    return this.importBytes(Buffer.from(parsed.data.text, 'utf8'), parsed.data.name);
  }
  importBytes(bytes: Uint8Array, name: string) {
    formatOf(name);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) return Promise.reject(new DocumentError('DOCUMENT_LIMIT', '文件不能为空或超过 20 MiB', 413));
    const copy = new Uint8Array(bytes); const hash = digest(copy);
    return this.serial(async () => {
      const existing = this.storage.capture().documents().find((doc) => doc.contentHash === hash);
      if (existing) {
        const job = existing.ingestion ? this.storage.capture().job(existing.ingestion.latestJobId) : undefined;
        if (!job) throw new DocumentError('DOCUMENT_EXISTS', '该内容已在旧索引中', 409);
        await this.files.source(existing);
        return { document: existing, job, deduplicated: true };
      }
      this.capacity(); const docs = this.storage.capture().documents();
      if (docs.length >= 1000 || docs.reduce((n, d) => n + (d.ingestion?.bytes ?? 0), 0) + copy.length > 256 * 1024 * 1024) throw new DocumentError('DOCUMENT_LIMIT', '文档数量或原文件总量超过本地上限', 413);
      await this.files.putSource(copy);
      const document: DocumentRecord = { id: `d-${hash}`, name, contentHash: hash, version: 1, status: 'queued', createdAt: now(), updatedAt: now() };
      const job = this.newJob(document); document.ingestion = { sourceKey: `${hash}.blob`, bytes: copy.length, latestJobId: job.id };
      await this.storage.transact((draft) => { draft.documents.set(document.id, document); draft.kv.fullDocs.set(document.id, JsonSchema.parse(document)); draft.jobs.set(job.id, job); });
      this.kick(); return { document, job, deduplicated: false };
    });
  }
  list(offset: number, limit: number) {
    const docs = this.storage.capture().documents().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: docs.slice(offset, offset + limit), total: docs.length, offset, limit };
  }
  detail(id: string) {
    const view = this.storage.capture(); const doc = view.document(id);
    if (!doc) throw new DocumentError('DOCUMENT_NOT_FOUND', '文档不存在', 404);
    return { document: doc, job: doc.ingestion ? view.job(doc.ingestion.latestJobId) ?? null : null };
  }
  job(id: string) { const job = this.storage.capture().job(id); if (!job) throw new DocumentError('JOB_NOT_FOUND', '任务不存在', 404); return job; }
  async parsed(id: string) {
    const { document, job } = this.detail(id);
    if (!job?.result) throw new DocumentError('PARSE_NOT_READY', '文档尚无完整解析产物', 409);
    const artifact = await this.files.artifact(job, document);
    return { text: artifact.document.text.slice(0, 20_000), previewTruncated: artifact.document.text.length > 20_000,
      blocks: artifact.document.blocks.slice(0, 100), blocksTruncated: artifact.document.blocks.length > 100, warnings: artifact.document.warnings,
      chunkCount: artifact.chunks.length, metadata: artifact.document.metadata, configRevision: job.configRevision };
  }
  retry(id: string, expectedJobId: string) {
    return this.serial(async () => {
      const { document, job } = this.detail(id);
      if (!job || !document.ingestion) throw new DocumentError('RETRY_UNAVAILABLE', '该文档没有可重试任务', 409);
      if (job.previousJobId === expectedJobId) return { document, job, deduplicated: true };
      if (job.id !== expectedJobId) throw new DocumentError('JOB_CONFLICT', '任务已更新，请重新加载', 409);
      if (!retryable.has(job.status)) throw new DocumentError('RETRY_UNAVAILABLE', '当前任务不可重试', 409);
      this.capacity(); await this.files.source(document);
      const next = this.newJob(document, job); const doc = { ...document, status: next.status, updatedAt: now(), ingestion: { ...document.ingestion, latestJobId: next.id } };
      await this.storage.transact((draft) => { draft.documents.set(doc.id, doc); draft.kv.fullDocs.set(doc.id, { ...doc }); draft.jobs.set(next.id, next); });
      this.kick(); return { document: doc, job: next, deduplicated: false };
    });
  }
  async cancel(id: string) {
    let result: JobRecord | undefined;
    await this.storage.transact((draft) => {
      const job = draft.jobs.get(id); if (!job) throw new DocumentError('JOB_NOT_FOUND', '任务不存在', 404);
      if (['processed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) { result = job; return; }
      result = this.update(draft, job, { cancelRequested: true,
        ...(!this.active.has(id) ? { status: 'cancelled' as const, phase: 'cancelled' as const, error: null, errorCode: 'CANCELLED' } : {}) });
    });
    this.active.get(id)?.controller.abort(); return result!;
  }
  private kick() {
    if (this.scheduled || this.closing) return; this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    if (!this.healthy) return;
    for (const job of this.storage.capture().jobs()) {
      if (this.active.size >= 2) break;
      if (job.status !== 'queued' || this.active.has(job.id)) continue;
      const controller = new AbortController();
      const done = this.run(job.id, controller.signal).finally(() => { this.active.delete(job.id); this.kick(); });
      this.active.set(job.id, { controller, done });
    }
  }
  private async run(id: string, signal: AbortSignal) {
    let phases: Promise<void> = Promise.resolve();
    try {
      await this.storage.transact((draft) => { const job = draft.jobs.get(id)!;
        if (job.cancelRequested || job.status !== 'queued') return;
        this.update(draft, job, { status: 'parsing', phase: 'parsing' }); });
      const job = this.job(id); if (job.status !== 'parsing') return;
      await this.options.hook?.('before-parse', job, signal); signal.throwIfAborted();
      const doc = this.detail(job.documentId!).document; const bytes = await this.files.source(doc);
      const prepared = await prepareDocument(bytes, doc.name, { docId: doc.id, docVersion: doc.version, encoding: job.preparation?.encoding ?? 'cl100k_base' }, {
        signal, onPhase: (phase) => { phases = phases.then(async () => {
          if (!this.storage.healthy) return;
          await this.storage.transact((draft) => { const current = draft.jobs.get(id)!;
            if (!current.cancelRequested && current.status !== phase && executing.has(current.status)) this.update(draft, current, { status: phase, phase }); });
        }); void phases.catch(() => {}); },
      });
      await phases; await this.options.hook?.('after-parse', job, signal); signal.throwIfAborted();
      await this.storage.transact((draft) => { const current = draft.jobs.get(id)!;
        if (!current.cancelRequested) this.update(draft, current, { phase: 'persisting_parse' }); });
      signal.throwIfAborted();
      await this.serial(async () => {
        signal.throwIfAborted();
      const existingBytes = this.storage.capture().jobs().reduce((total, j) => total + (j.result?.bytes ?? 0), 0);
      const artifact = { schemaVersion: 1 as const, documentId: doc.id, docVersion: doc.version, configRevision: job.configRevision, ...prepared };
      if (existingBytes + Buffer.byteLength(JSON.stringify(artifact)) > 256 * 1024 * 1024) throw new DocumentError('ARTIFACT_LIMIT', '解析产物累计上限已满', 413);
      const result = await this.files.putArtifact(id, artifact);
      await this.options.hook?.('before-final', job, signal);
      await this.storage.transact((draft) => {
        const current = draft.jobs.get(id)!;
        if (current.cancelRequested || signal.aborted || this.closing) {
          this.update(draft, current, { status: current.cancelRequested ? 'cancelled' : 'interrupted', phase: current.cancelRequested ? 'cancelled' : 'interrupted', error: null }); return;
        }
        const changed = this.config.capture().revision !== current.configRevision;
        const missing = current.preparation?.missingRoles.length;
        const status = missing || changed ? 'awaiting_configuration' : 'awaiting_indexing';
        this.update(draft, current, { status, phase: status, result,
          warnings: [...prepared.document.warnings.map(({ code, message }) => ({ code, message })),
            { code: changed ? 'CONFIG_CHANGED' : missing ? 'MODELS_REQUIRED' : 'INDEXER_PENDING', message: changed ? '配置已变化，手动重试以捕获新版本' : missing ? '本地解析完成，配置模型后手动重试' : '本地解析完成，索引构建将在 S06 接入' }], error: null });
      });
      });
    } catch (error) {
      await phases.catch(() => {});
      if (!this.storage.healthy) return;
      await this.storage.transact((draft) => {
        const current = draft.jobs.get(id); if (!current || !executing.has(current.status)) return;
        const cancelled = current.cancelRequested; const interrupted = this.closing;
        const safe = error instanceof ParserError || error instanceof DocumentError;
        this.update(draft, current, { status: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed', phase: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed',
          errorCode: cancelled ? 'CANCELLED' : interrupted ? 'INTERRUPTED' : safe ? error.code : 'TASK_FAILED',
          error: cancelled ? null : interrupted ? '服务退出中断任务；请手动重试' : safe ? error.message : '文档任务执行失败，请检查后手动重试' });
      }).catch(() => { this.broken = true; });
    }
  }
  async close() {
    this.closing = true; for (const active of this.active.values()) active.controller.abort();
    await this.admission; await Promise.all([...this.active.values()].map((a) => a.done));
    if (this.storage.healthy && this.storage.capture().jobs().some((j) => executing.has(j.status))) await this.storage.transact((draft) => {
      for (const [, job] of draft.jobs.entries()) if (executing.has(job.status)) this.update(draft, job, { status: job.cancelRequested ? 'cancelled' : 'interrupted', phase: job.cancelRequested ? 'cancelled' : 'interrupted', error: '服务退出中断任务；请手动重试', errorCode: 'INTERRUPTED' });
    });
  }
}
