import { IndexMaintenance } from '../indexing/maintenance.js';
import { cleanupFiles } from './cleanup.js';
import { MaintenanceRequestSchema, MaintenanceStateSchema } from '@tslightrag/contracts';
import type { Replacement } from '../indexing/maintenance.js';
import { Indexer } from '../indexing/indexer.js';
import { ModelClient } from '../models/client.js';
import { ModelError } from '../models/errors.js';
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

export interface DocumentServiceOptions { client?:ModelClient; hook?: (point: 'before-parse' | 'after-parse' | 'before-final' | 'before-index-final' | 'before-maintenance-final' | 'after-maintenance-final', job: JobRecord, signal: AbortSignal) => Promise<void> }
const executing = new Set(['queued', 'parsing', 'chunking', 'extracting', 'embedding', 'committing']);
const retryable = new Set(['failed', 'cancelled', 'interrupted', 'awaiting_configuration', 'awaiting_indexing']);
const now = () => new Date().toISOString();
export class DocumentService {
  private readonly indexer: Indexer;
  private readonly maintenance: IndexMaintenance;
  private closing = false;
  private broken = false;
  private admission: Promise<void> = Promise.resolve();
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private scheduled = false;
  private constructor(private readonly storage: SnapshotStore, private readonly config: ModelConfigStore,
    readonly files: DocumentFiles, private readonly options: DocumentServiceOptions) { const client=options.client??new ModelClient();this.indexer = new Indexer(storage, config,client); this.maintenance = new IndexMaintenance(storage,config,this.indexer,client); }
  static async open(storage: SnapshotStore, config: ModelConfigStore, options: DocumentServiceOptions = {}) {
    const files = new DocumentFiles(storage.dataDir); await files.initialize();
    const service = new DocumentService(storage, config, files, options);
    for (const doc of storage.capture().documents()) if (doc.ingestion) await files.source(doc);
    for (const job of storage.capture().jobs()) if (job.result && job.documentId) {
      const doc = storage.capture().document(job.documentId); if (!doc) throw new DocumentError('JOB_INVALID', '任务文档缺失', 503);
      await files.artifact(job, job.artifactDocument ?? doc);
    }
    if (storage.capture().jobs().some((job) => executing.has(job.status))) await storage.transact((draft) => {
      for (const [, job] of draft.jobs.entries()) if (executing.has(job.status)) service.update(draft, job, {
        status: job.cancelRequested ? 'cancelled' : 'interrupted', phase: job.cancelRequested ? 'cancelled' : 'interrupted',
        error: job.cancelRequested ? null : '服务重启中断任务；请手动重试', errorCode: job.cancelRequested ? 'CANCELLED' : 'INTERRUPTED',
      });
    });
    await service.cleanup();
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
  private globalBusy() {
    return this.storage.capture().jobs().some((j)=>executing.has(j.status)&&(j.operation==='rebuild'||j.maintenance?.all));
  }
  private capacity() {
    if(this.globalBusy()) throw new DocumentError('MAINTENANCE_BUSY','全库维护进行中，请稍后操作',409);
    const view = this.storage.capture();
    if (view.jobs().filter((j) => executing.has(j.status)).length >= 10) throw new DocumentError('JOB_QUEUE_FULL', '处理队列已满，请稍后再导入', 429);
    if (view.jobs().length >= 5000) throw new DocumentError('JOB_LIMIT', '任务记录达到 5000 项上限', 413);
  }
  private newJob(doc: DocumentRecord, previous?: JobRecord): JobRecord {
    const config = this.config.captureForIndex(); const text = boundProfile(config, 'query');
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
  list(offset: number, limit: number, q = '', status?: DocumentRecord['status']) {
    const docs = this.storage.capture().documents().filter((doc) => doc.name.toLocaleLowerCase().includes(q.toLocaleLowerCase()) && (!status || doc.status === status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: docs.slice(offset, offset + limit), total: docs.length, offset, limit };
  }
  detail(id: string) {
    const view = this.storage.capture(); const doc = view.document(id);
    if (!doc) throw new DocumentError('DOCUMENT_NOT_FOUND', '文档不存在', 404);
    const related=view.jobs().filter((j)=>j.documentId===id).sort((a,b)=>(b.createdAt??b.updatedAt).localeCompare(a.createdAt??a.updatedAt));
    return { document: doc, job: related[0] ?? null };
  }
  job(id: string) { const job = this.storage.capture().job(id); if (!job) throw new DocumentError('JOB_NOT_FOUND', '任务不存在', 404); return job; }
  async parsed(id: string) {
    const { document } = this.detail(id);
    const job = document.ingestion ? this.storage.capture().job(document.ingestion.latestJobId) : undefined;
    if (!job?.result) throw new DocumentError('PARSE_NOT_READY', '文档尚无完整解析产物', 409);
    const artifact = await this.files.artifact(job, document);
    return { text: artifact.document.text.slice(0, 20_000), previewTruncated: artifact.document.text.length > 20_000,
      blocks: artifact.document.blocks.slice(0, 100), blocksTruncated: artifact.document.blocks.length > 100, warnings: artifact.document.warnings,
      chunkCount: artifact.chunks.length, metadata: artifact.document.metadata, configRevision: job.configRevision };
  }
  retry(id: string, expectedJobId: string) {
    const current=this.detail(id).job;
    if(current?.operation!=='index'&&current){
      const parent=current.previousJobId===expectedJobId?this.job(expectedJobId):current;
      if(parent.id!==expectedJobId)throw new DocumentError('JOB_CONFLICT','任务已更新',409);
      return this.requestMaintenance(parent.operation as 'delete'|'reindex',id,{expectedCorpusRevision:this.storage.capture().corpusRevision,expectedConfigRevision:this.config.capture().revision,expectedDocumentVersion:parent.maintenance?.sourceVersion},parent.id).then((job)=>({document:this.detail(id).document,job,deduplicated:job.previousJobId===expectedJobId&&job.id===current.id}));
    }
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
      const done = (job.operation==='index' ? this.run(job.id, controller.signal) : this.runMaintenance(job.id,controller.signal)).finally(() => { this.active.delete(job.id); this.kick(); });
      this.active.set(job.id, { controller, done });
    }
  }
  private async run(id: string, signal: AbortSignal) {
    let phases: Promise<void> = Promise.resolve();
    try {
      const capturedConfig = this.config.captureForIndex();
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
        const status = missing || changed ? 'awaiting_configuration' : 'extracting';
        this.update(draft, current, { status, phase: status, result, artifactDocument: {id:doc.id,version:doc.version,contentHash:doc.contentHash},
          warnings: [...prepared.document.warnings.map(({ code, message }) => ({ code, message })),
            ...(changed || missing ? [{ code: changed ? 'CONFIG_CHANGED' : 'MODELS_REQUIRED', message: changed ? '配置已变化，手动重试以捕获新版本' : '本地解析完成，配置模型后手动重试' }] : [])], error: null });
      });
      });
      if (this.job(id).status !== 'extracting') return;
      const guard = () => {
        signal.throwIfAborted();
        const current = this.job(id);
        if (current.cancelRequested || this.closing) throw new DocumentError('CANCELLED', '任务已取消', 409);
        if (capturedConfig.revision !== job.configRevision || this.config.capture().revision !== job.configRevision) throw new DocumentError('CONFIG_CHANGED', '配置已变化，手动重试以捕获新版本', 409);
      };
      guard();
      const contributions = await this.indexer.prepare(prepared.chunks, capturedConfig, signal);
      await this.indexer.publish(prepared.chunks, doc, prepared.document.text, contributions, capturedConfig, signal, async (phase) => {
        guard(); await this.storage.transact((draft) => { this.update(draft, draft.jobs.get(id)!, { status: phase, phase }); });
        if (phase === 'committing') await this.options.hook?.('before-index-final', this.job(id), signal);
      }, (draft) => { this.update(draft, draft.jobs.get(id)!, { status: 'processed', phase: 'processed', error: null }); }, guard);
    } catch (error) {
      await phases.catch(() => {});
      if (!this.storage.healthy) return;
      await this.storage.transact((draft) => {
        const current = draft.jobs.get(id); if (!current || !executing.has(current.status)) return;
        const cancelled = current.cancelRequested; const interrupted = this.closing;
        const safe = error instanceof ParserError || error instanceof ModelError;
        this.update(draft, current, { status: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed', phase: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed',
          errorCode: cancelled ? 'CANCELLED' : interrupted ? 'INTERRUPTED' : safe ? error.code : 'TASK_FAILED',
          error: cancelled ? null : interrupted ? '服务退出中断任务；请手动重试' : safe ? error.message : '文档任务执行失败，请检查后手动重试' });
      }).catch(() => { this.broken = true; });
    }
  }
  async cleanup() {
    for(const task of this.storage.capture().cleanupTasks) if(task.status!=='done') {
      let status: 'pending'|'retained'|'done'|'failed'='failed';
      try {status=await cleanupFiles(this.storage,task);} catch { /* A durable task remains retryable. */ }
      await this.storage.transact((draft)=>{ const current=draft.cleanupTasks.find((t)=>t.id===task.id); if(current){current.status=status;current.attempts++;current.error=status==='failed'?'文件释放失败，请修复路径/权限后重试':status==='retained'?'保留快照或任务仍引用文件，尚未释放':null;} });
    }
    return this.storage.capture().cleanupTasks;
  }
  retryCleanup(){return this.serial(()=>this.cleanup());}
  retryMaintenance(id:string,input:unknown){const job=this.job(id);if(job.operation==='index')throw new DocumentError('RETRY_UNAVAILABLE','导入任务请通过文档重试',409);return this.requestMaintenance(job.operation,job.documentId,input,job.id);}
  maintenanceState() {const view=this.storage.capture();return MaintenanceStateSchema.parse({corpusRevision:view.corpusRevision,jobs:view.jobs().filter((j)=>j.operation!=='index').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),cleanupTasks:view.cleanupTasks,activeIndex:this.config.public().activeIndex});}
  requestMaintenance(operation: 'delete'|'reindex'|'rebuild', id: string|null, input: unknown, previousJobId?:string) {
    return this.serial(async()=>{
      const parsed=MaintenanceRequestSchema.safeParse(input); if(!parsed.success) throw new DocumentError('INVALID_MAINTENANCE','维护请求需要语料/配置版本等有效参数',400);
      const parent=previousJobId?this.job(previousJobId):undefined;
      if(parent){const successor=this.storage.capture().jobs().find((j)=>j.previousJobId===parent.id);if(successor)return successor;if(!retryable.has(parent.status)||parent.documentId!==id)throw new DocumentError('RETRY_UNAVAILABLE','维护任务不可重试',409);}
      const value=parsed.data;this.capacity();const view=this.storage.capture();const config=this.config.capture();
      if(view.corpusRevision!==value.expectedCorpusRevision||config.revision!==value.expectedConfigRevision)throw new DocumentError('REVISION_CONFLICT','语料或配置已更新，请重新加载',409);
      const doc=id?view.document(id):undefined;
      if(id&&!doc)throw new DocumentError('DOCUMENT_NOT_FOUND','文档不存在',404);
      if(doc&&doc.version!==value.expectedDocumentVersion)throw new DocumentError('DOCUMENT_CONFLICT','需要当前文档版本',409);
      if(doc&&view.jobs().some((j)=>j.documentId===id&&executing.has(j.status)))throw new DocumentError('DOCUMENT_BUSY','该文档已有活动任务',409);
      if(!id&&view.jobs().some((j)=>executing.has(j.status)))throw new DocumentError('MAINTENANCE_BUSY','请等待或取消活动任务后再执行全库维护',409);
      if(operation==='reindex'&&(!doc||doc.status!=='processed'||!doc.ingestion))throw new DocumentError('REINDEX_UNAVAILABLE','只能重新索引有原文的已处理文档',409);
      if(operation==='rebuild'&&!config.profiles.some((p)=>p.id===value.targetProfileId&&p.kind==='embedding'))throw new DocumentError('INVALID_PROFILE','需要已保存的目标向量模型',400);
      if(value.replacement&&operation!=='reindex')throw new DocumentError('INVALID_MAINTENANCE','仅重新索引支持替换文本',400);
      let replacement: NonNullable<JobRecord['maintenance']>['replacement']=parent?.maintenance?.replacement;
      if(value.replacement){
        const text=ImportTextSchema.parse(value.replacement); if(!text.text.trim()||!['txt','md'].includes(formatOf(text.name)))throw new DocumentError('INVALID_TEXT_FORMAT','替换文本仅支持非空 TXT/Markdown',400);
        const bytes=Buffer.from(text.text);const hash=digest(bytes);
        if(view.documents().reduce((n,d)=>n+(d.id===id?0:d.ingestion?.bytes??0),0)+bytes.length>256*1024*1024)throw new DocumentError('DOCUMENT_LIMIT','替换后原文总量超过本地上限',413);
        if(view.documents().some((d)=>d.id!==id&&d.contentHash===hash))throw new DocumentError('DOCUMENT_EXISTS','相同内容已属于其他文档',409);
        await this.files.putSource(bytes);replacement={name:text.name,contentHash:hash,bytes:bytes.length};
      }
      const job:JobRecord={id:`j-${randomUUID()}`,documentId:id,operation,status:'queued',phase:'queued',attempt:(parent?.attempt??0)+1,...(parent?{previousJobId:parent.id}:{}),configRevision:config.revision,cancelRequested:false,error:null,createdAt:now(),updatedAt:now(),
        maintenance:{expectedCorpusRevision:view.corpusRevision,...(doc?{sourceVersion:doc.version}:{}),...(operation==='delete'&&!id?{all:true}:{}),...(value.targetProfileId?{targetProfileId:value.targetProfileId}:{}),...(replacement?{replacement}:{})}};
      await this.storage.transact((draft)=>{draft.jobs.set(job.id,job);});this.kick();return job;
    });
  }
  private async runMaintenance(id:string,signal:AbortSignal) {
    try {
      let job=this.job(id); const config=job.operation==='rebuild'?this.config.capture():this.config.captureForIndex();
      const guard=()=>{signal.throwIfAborted();if(this.closing||this.job(id).cancelRequested)throw new DocumentError('CANCELLED','维护已取消',409);if(this.config.capture().revision!==job.configRevision||config.revision!==job.configRevision)throw new DocumentError('CONFIG_CHANGED','配置已变化，请重新发起维护',409);};
      guard(); await this.storage.transact((draft)=>{const status=job.operation==='reindex'?'parsing':'extracting';this.update(draft,draft.jobs.get(id)!,{status,phase:status});});
      let replacement:Replacement|undefined;
      if(job.operation==='reindex') {
        const old=this.storage.capture().document(job.documentId!)!;const update=job.maintenance?.replacement;
        const doc:DocumentRecord={...old,name:update?.name??old.name,version:old.version+1,contentHash:update?.contentHash??old.contentHash,status:'processed',updatedAt:now(),ingestion:{sourceKey:`${update?.contentHash??old.contentHash}.blob`,bytes:update?.bytes??old.ingestion!.bytes,latestJobId:id}};
        const bytes=await this.files.source(doc); const text=boundProfile(config,'extract');
        const prepared=await prepareDocument(bytes,doc.name,{docId:doc.id,docVersion:doc.version,encoding:text?.kind==='text'?text.tokenizer:'cl100k_base'},{signal});guard();
        const artifact={schemaVersion:1 as const,documentId:doc.id,docVersion:doc.version,configRevision:job.configRevision,...prepared};
        await this.serial(async()=>{
          guard();const used=this.storage.capture().jobs().reduce((n,j)=>n+(j.result?.bytes??0),0);
          if(used+Buffer.byteLength(JSON.stringify(artifact))>256*1024*1024)throw new DocumentError('ARTIFACT_LIMIT','解析产物累计上限已满',413);
          const result=await this.files.putArtifact(id,artifact);
          await this.storage.transact((draft)=>{guard();this.update(draft,draft.jobs.get(id)!,{status:'extracting',phase:'extracting',result,artifactDocument:{id:doc.id,version:doc.version,contentHash:doc.contentHash}});});
        });
        replacement={document:doc,artifact,contributions:await this.indexer.prepare(prepared.chunks,config,signal)};
      }
      job=this.job(id);guard();
      await this.maintenance.execute(job,config,signal,async(phase)=>{
        guard();await this.storage.transact((draft)=>{this.update(draft,draft.jobs.get(id)!,{status:phase,phase});});
        if(phase==='committing')await this.options.hook?.('before-maintenance-final',this.job(id),signal);
      },guard,(draft)=>{this.update(draft,draft.jobs.get(id)!,{status:'processed',phase:'processed',error:null});},replacement);
      await this.options.hook?.('after-maintenance-final',this.job(id),signal);
      await this.serial(()=>this.cleanup());
    } catch(error) {
      if(!this.storage.healthy)return;
      await this.storage.transact((draft)=>{const job=draft.jobs.get(id);if(!job||!executing.has(job.status))return;const status=job.cancelRequested?'cancelled':this.closing?'interrupted':'failed';const safe=error instanceof ModelError||error instanceof ParserError;
        this.update(draft,job,{status,phase:status,errorCode:status==='failed'&&safe?error.code:status==='failed'?'TASK_FAILED':status.toUpperCase(),error:status==='cancelled'?null:safe?error.message:'维护未完成，旧索引保持可用'});
      }).catch(()=>{this.broken=true;});
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
