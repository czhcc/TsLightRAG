import { useEffect, useRef, useState } from 'react';
import { ApiErrorSchema, DocumentDetailSchema, DocumentListSchema, ImportResultSchema, DocumentStatusSchema,
  JobSchema, MaintenanceStateSchema, ModelSettingsSchema } from '@tslightrag/contracts';
import type { DocumentRecord, JobRecord } from '@tslightrag/contracts';
import type { z } from 'zod';
import { Dialog } from './Dialog.js';

const labels: Record<string, string> = { queued: '排队中', extracting: '实体关系抽取', embedding: '生成向量', committing: '提交索引', parsing: '本地解析', chunking: '文本分块', awaiting_configuration: '待配置模型', awaiting_indexing: '待建立索引（需重试）', failed: '失败', cancelled: '已取消', interrupted: '已中断', processed: '已索引' };
const operations: Record<string, string> = { index: '导入', delete: '删除', reindex: '重新索引', rebuild: '重建向量' };
const running = (job: JobRecord) => ['queued', 'parsing', 'chunking', 'extracting', 'embedding', 'committing'].includes(job.status);
const terminal = (job: JobRecord) => ['processed', 'failed', 'cancelled', 'interrupted'].includes(job.status);
class DocumentRequestError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
async function request(path: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(`/api/v1${path}`, { ...init, signal, headers: { Accept: 'application/json', ...init.headers } });
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(await response.json().catch(() => null));
    throw new DocumentRequestError(error.success ? error.data.message : `请求失败（HTTP ${String(response.status)}）`, response.status);
  }
  return response.json() as Promise<unknown>;
}
type Detail = z.infer<typeof DocumentDetailSchema>;
type Modal = 'file' | 'text' | 'detail' | 'delete' | 'reindex';
export function Documents() {
  const [listing, setListing] = useState<z.infer<typeof DocumentListSchema> | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [target, setTarget] = useState<DocumentRecord | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [preview, setPreview] = useState(''), [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState(''), [statusFilter, setStatusFilter] = useState('');
  const [name, setName] = useState('文档.txt'), [text, setText] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(new Map<string, { name: string; operation: string; documentId: string }>());
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id'); if (!id) return;
    const abort = new AbortController();
    void request(`/documents/${encodeURIComponent(id)}`, abort.signal).then(value => {
      if (!abort.signal.aborted) { setDetail(DocumentDetailSchema.parse(value)); setModal('detail'); }
    }).catch(e => { if (!abort.signal.aborted) setMessage(e instanceof Error ? e.message : '来源文档加载失败'); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [value, state] = await Promise.all([
          request(`/documents?${new URLSearchParams({ offset: String(offset), limit: '10', q: filter, ...(statusFilter ? { status: statusFilter } : {}) })}`, abort.signal).then(v => DocumentListSchema.parse(v)),
          request('/maintenance', abort.signal).then(v => MaintenanceStateSchema.parse(v)),
        ]);
        if (abort.signal.aborted) return;
        setListing(value); setJobs(state.jobs);
        if (offset && !value.items.length && value.total <= offset) setOffset(Math.max(0, Math.floor((value.total - 1) / 10) * 10));
        let deleted = false;
        for (const [id, item] of pending.current) {
          const job = state.jobs.find(j => j.id === id); if (!job || !terminal(job)) continue;
          pending.current.delete(id);
          setMessage(job.status === 'processed' ? `${item.name}：${operations[item.operation]}已完成` : `${item.name}：${operations[item.operation]}${labels[job.status]}${job.error ? ` · ${job.error}` : ''}`);
          if (detail?.document.id === item.documentId) {
            setPreview('');
            if (item.operation === 'delete' && job.status === 'processed') { deleted = true; setDetail(null); setModal(null); }
          }
        }
        if (detail && !deleted) {
          try { const current = DocumentDetailSchema.parse(await request(`/documents/${detail.document.id}`, abort.signal)); if (!abort.signal.aborted) setDetail(current); }
          catch (e) { if (e instanceof DocumentRequestError && e.statusCode === 404) { setDetail(null); setModal(null); setMessage('该文档已被删除'); } else throw e; }
        }
      } catch (e) { if (!abort.signal.aborted) setMessage(e instanceof Error ? e.message : '列表加载失败'); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => { void load(); }, 1000); }
    };
    void load(); return () => { abort.abort(); clearTimeout(timer); };
  }, [offset, refresh, detail?.document.id, filter, statusFilter]);
  async function perform(work: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setBusy(true); setMessage('');
    try { await work(abort.signal); if (!abort.signal.aborted) setRefresh(v => v + 1); }
    catch (e) { if (!abort.signal.aborted) setMessage(e instanceof Error ? e.message : '操作失败'); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  function close() {
    if (busy) return;
    setModal(null); setDetail(null); setTarget(null); setPreview('');
    if (new URLSearchParams(window.location.search).has('id')) window.history.replaceState({}, '', '/documents');
  }
  const accepted = (value: unknown) => {
    const result = ImportResultSchema.parse(value); setDetail({ document: result.document, job: result.job }); setPreview(''); setModal('detail');
    setMessage(result.job.operation === 'index'
      ? result.deduplicated ? '相同内容已存在，未新建任务' : '原文和任务已持久保存，已接受导入'
      : `${operations[result.job.operation]}任务已保存，完成前继续使用旧索引`);
  };
  function upload(file: File) {
    if (busy) return;
    if (!file.size || file.size > 20 * 1024 * 1024) { setMessage('文件不能为空或超过 20 MiB'); return; }
    if (!/\.(txt|md|markdown|html|htm|csv|json|pdf|docx|xlsx|pptx)$/i.test(file.name)) { setMessage('不支持的文件格式，请选择关于页解析能力表中的格式'); return; }
    void perform(async signal => { const form = new FormData(); form.append('file', file); accepted(await request('/documents', signal, { method: 'POST', body: form })); });
  }
  function action(doc: DocumentRecord, kind: 'delete' | 'reindex') { setTarget(doc); setMessage(''); setModal(kind); }
  function submitAction() {
    if (!target || (modal !== 'delete' && modal !== 'reindex')) return;
    const doc = target, operation = modal;
    void perform(async signal => {
      const [state, models] = await Promise.all([
        request('/maintenance', signal).then(v => MaintenanceStateSchema.parse(v)),
        request('/settings/models', signal).then(v => ModelSettingsSchema.parse(v)),
      ]);
      const job = JobSchema.parse(await request(`/documents/${doc.id}${operation === 'reindex' ? '/reindex' : ''}`, signal, {
        method: operation === 'delete' ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedCorpusRevision: state.corpusRevision, expectedConfigRevision: models.revision, expectedDocumentVersion: doc.version }),
      }));
      pending.current.set(job.id, { name: doc.name, operation, documentId: doc.id }); setJobs(current => [job, ...current.filter(j => j.id !== job.id)]);
      setModal(null); setTarget(null); setDetail(null); setPreview('');
      setMessage(`${doc.name}：已提交${operations[operation]}任务，完成前继续使用旧索引`);
    });
  }
  const currentJob = detail?.job;
  const dialogTitle = modal === 'file' ? '导入文档' : modal === 'text' ? '粘贴文本' : modal === 'detail' ? `任务详情：${detail?.document.name ?? ''}` : `${modal === 'delete' ? '删除文档' : '重新索引'}：${target?.name ?? ''}`;
  return <section aria-label="文档管理">
    <div className="document-toolbar"><h2>文档列表</h2><div><button disabled={busy} onClick={() => { setMessage(''); setModal('file'); }}>导入文档</button><button disabled={busy} onClick={() => { setMessage(''); setModal('text'); }}>粘贴文本</button><button disabled={busy} className="secondary" onClick={() => { setRefresh(v => v + 1); }}>刷新列表</button></div></div>
    {!modal && <p role="status">{message}</p>}
    <div className="document-filters"><label>按名称过滤<input value={filter} maxLength={255} onChange={e => { setFilter(e.target.value); setOffset(0); }} /></label>
      <div><label htmlFor="document-status-filter">按状态过滤</label><select id="document-status-filter" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setOffset(0); }}><option value="">全部状态</option>{DocumentStatusSchema.options.map(status => <option key={status} value={status}>{labels[status]}</option>)}</select></div>
    </div>
    <p>共 {listing?.total ?? 0} 个文档</p>
    <div className="document-table"><table><thead><tr><th>名称</th><th>状态</th><th>版本</th><th>操作</th></tr></thead><tbody>
      {listing?.items.map(doc => {
        const job = jobs.find(j => j.documentId === doc.id), active = job && running(job);
        const working = active || ['queued', 'parsing', 'chunking', 'extracting', 'embedding', 'committing'].includes(doc.status);
        return <tr key={doc.id}><td>{doc.name}</td><td>{active ? `${operations[job.operation]} · ${labels[job.status]}` : labels[doc.status] ?? doc.status}{job?.status === 'failed' && <small className="document-task-error">{operations[job.operation]}失败，请查看详情</small>}</td><td>{doc.version}</td><td className="document-actions">
          <button disabled={busy} onClick={() => { void perform(async signal => { setDetail(DocumentDetailSchema.parse(await request(`/documents/${doc.id}`, signal))); setPreview(''); setModal('detail'); }); }}>查看</button>
          <button disabled={busy || Boolean(working)} className="secondary" onClick={() => { action(doc, 'delete'); }}>删除</button>
          <button disabled={busy || Boolean(working) || doc.status !== 'processed' || !doc.ingestion} className="secondary" onClick={() => { action(doc, 'reindex'); }}>重新索引</button>
        </td></tr>;
      })}
    </tbody></table></div>
    {listing?.total === 0 && <p className="muted">没有匹配的文档，可导入文件或粘贴文本。</p>}
    <div className="document-pagination"><button disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 10)); }}>上一页</button><button disabled={!listing || offset + 10 >= listing.total} onClick={() => { setOffset(offset + 10); }}>下一页</button></div>
    {modal && <Dialog title={dialogTitle} busy={busy} onClose={close}>
      {modal === 'file' && <><p>文件在本地解析与分块，再使用所配置的模型建立索引。最大 20 MiB。</p>
        <div className="drop-zone" role="region" aria-label="拖放文件导入" onDragOver={e => e.preventDefault()} onDrop={e => {
          e.preventDefault(); if (busy) return; if (e.dataTransfer.files.length !== 1) { setMessage('每次请拖放一个文件'); return; }
          const file = e.dataTransfer.files[0]; if (file) upload(file);
        }}><p>拖放一个文件，或选择本地文件。支持 TXT、Markdown、HTML、CSV、JSON、PDF、DOCX、XLSX、PPTX。</p>
          <label>选择文件<input type="file" disabled={busy} accept=".txt,.md,.markdown,.html,.htm,.csv,.json,.pdf,.docx,.xlsx,.pptx" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) upload(file); }} /></label>
        </div></>}
      {modal === 'text' && <form onSubmit={e => { e.preventDefault(); void perform(async signal => { accepted(await request('/documents/text', signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text }) })); }); }}>
        <fieldset disabled={busy}><legend>文本内容</legend><label>文档名称<input required maxLength={255} value={name} onChange={e => { setName(e.target.value); }} /></label>
          <label htmlFor="document-body">文档正文</label><textarea id="document-body" required rows={8} value={text} onChange={e => { setText(e.target.value); }} />
          <button type="submit" disabled={!name.trim() || !text.trim()}>导入文本</button></fieldset>
      </form>}
      {modal === 'detail' && detail && <section aria-label="任务详情">
        <p>状态：{labels[currentJob?.status ?? detail.document.status] ?? detail.document.status}</p>
        <p>任务：{currentJob ? operations[currentJob.operation] : '无'} · 文档版本：{detail.document.version}</p>
        <p>当前阶段：{currentJob?.phase ?? detail.document.status} · 尝试次数：{currentJob?.attempt ?? 0} · 配置版本：{currentJob?.configRevision ?? 0}</p>
        {currentJob?.operation !== 'index' && currentJob && currentJob.status !== 'processed' && <p>本次操作完成前保留原有索引。</p>}
        {currentJob?.error && <p role="alert">{currentJob.errorCode}：{currentJob.error}</p>}
        {currentJob?.warnings?.map((w, i) => <p key={`${w.code}-${String(i)}`}>{w.message}</p>)}
        {currentJob && <><button disabled={busy || terminal(currentJob)} onClick={() => { void perform(async signal => { await request(`/jobs/${currentJob.id}/cancel`, signal, { method: 'POST' }); setMessage('已请求取消任务'); }); }}>取消任务</button>
          <button disabled={busy || !['failed', 'cancelled', 'interrupted', 'awaiting_configuration', 'awaiting_indexing'].includes(currentJob.status)} onClick={() => { void perform(async signal => { accepted(await request(`/documents/${detail.document.id}/retry`, signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedJobId: currentJob.id }) })); }); }}>重试任务</button></>}
        {currentJob?.result && <p>解析块：{currentJob.result.blocks} · 文本块：{currentJob.result.chunks}</p>}
        {detail.document.ingestion && <button disabled={busy} onClick={() => { void perform(async signal => {
          const result = await request(`/documents/${detail.document.id}/parsed`, signal) as { text: string; previewTruncated: boolean };
          setPreview(result.text + (result.previewTruncated ? '\n（预览已截断，原始解析产物完整保存）' : ''));
        }); }}>查看解析正文</button>}
        {preview && <pre aria-label="解析正文">{preview}</pre>}
      </section>}
      {(modal === 'delete' || modal === 'reindex') && target && <><p>文档：{target.name} · 版本 {target.version}</p>
        <p>{modal === 'delete' ? '删除文档及其索引贡献。其它文档仍引用的实体和关系会保留；历史快照仍引用的文件会延后释放。' : '使用原文件重新解析并建立索引。可能调用模型接口并产生费用；失败时保留旧索引。'}</p>
        <button disabled={busy} onClick={submitAction}>{modal === 'delete' ? '确认删除' : '确认重新索引'}</button></>}
      <p role="status">{message}</p>
      {busy && <button onClick={() => { controller.current?.abort(); setBusy(false); setRefresh(v => v + 1); setMessage('请求已停止，服务端可能已接受操作，请查看列表和任务详情核对。'); }}>停止请求</button>}
    </Dialog>}
  </section>;
}
