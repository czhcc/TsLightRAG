import { MaintenancePanel } from './Maintenance.js';
import { useEffect, useRef, useState } from 'react';
import { ApiErrorSchema, DocumentDetailSchema, DocumentListSchema, ImportResultSchema, DocumentStatusSchema } from '@tslightrag/contracts';
import type { z } from 'zod';
const labels: Record<string, string> = { queued: '排队中', extracting: '实体关系抽取', embedding: '生成向量', committing: '提交索引', parsing: '本地解析', chunking: '文本分块', awaiting_configuration: '待配置模型', awaiting_indexing: '待建立索引（需重试）', failed: '失败', cancelled: '已取消', interrupted: '已中断', processed: '已索引' };
async function request(path: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(`/api/v1${path}`, { ...init, signal, headers: { Accept: 'application/json', ...init.headers } });
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(await response.json().catch(() => null));
    throw new Error(error.success ? error.data.message : `请求失败（HTTP ${String(response.status)}）`);
  }
  return response.json() as Promise<unknown>;
}
export function Documents() {
  const [listing, setListing] = useState<z.infer<typeof DocumentListSchema> | null>(null);
  const [detail, setDetail] = useState<z.infer<typeof DocumentDetailSchema> | null>(null);
  const [preview, setPreview] = useState(''); const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState(''); const [statusFilter, setStatusFilter] = useState('');
  const [name, setName] = useState('文档.txt'); const [text, setText] = useState('');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id'); if (!id) return;
    const abort = new AbortController();
    void request(`/documents/${encodeURIComponent(id)}`, abort.signal).then(value => {
      if (!abort.signal.aborted) setDetail(DocumentDetailSchema.parse(value));
    }).catch(e => { if (!abort.signal.aborted) setMessage(e instanceof Error ? e.message : '来源文档加载失败'); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = DocumentListSchema.parse(await request(`/documents?${new URLSearchParams({ offset: String(offset), limit: '10', q: filter, ...(statusFilter ? { status: statusFilter } : {}) })}`, abort.signal));
        if (!abort.signal.aborted) setListing(value);
        if (detail) { const current = DocumentDetailSchema.parse(await request(`/documents/${detail.document.id}`, abort.signal)); if (!abort.signal.aborted) setDetail(current); }
      } catch (e) { if (!abort.signal.aborted) setMessage(e instanceof Error ? e.message : '列表加载失败'); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => { void load(); }, 1000); }
    };
    void load(); return () => { abort.abort(); clearTimeout(timer); };
  }, [offset, refresh, detail?.document.id, filter, statusFilter]); // Poll persisted facts; no synthetic progress clock.
  async function perform(work: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setBusy(true); setMessage('');
    try { await work(abort.signal); if (!abort.signal.aborted) setRefresh((v) => v + 1); }
    catch (e) { if (!abort.signal.aborted) setMessage(e instanceof Error ? e.message : '操作失败'); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  const accepted = (value: unknown) => {
    const result = ImportResultSchema.parse(value); setDetail({ document: result.document, job: result.job }); setPreview('');
    setMessage(result.deduplicated ? '相同内容已存在，未新建任务' : '原文和任务已持久保存，已接受导入');
  };
  function upload(file: File) {
    if (busy) return;
    if (!file.size || file.size > 20 * 1024 * 1024) { setMessage('文件不能为空或超过 20 MiB'); return; }
    if (!/\.(txt|md|markdown|html|htm|csv|json|pdf|docx|xlsx|pptx)$/i.test(file.name)) { setMessage('不支持的文件格式，请选择能力矩阵中的格式'); return; }
    void perform(async (signal) => { const form = new FormData(); form.append('file', file); accepted(await request('/documents', signal, { method: 'POST', body: form })); });
  }
  return <section aria-label="文档管理">
    <h2>导入文档</h2><p>原始文件和解析均保留在本机。文档在本地解析与分块，使用所配置的模型建立知识图谱与向量索引。</p>
    <div className="drop-zone" role="region" aria-label="拖放文件导入" onDragOver={e => e.preventDefault()} onDrop={e => {
      e.preventDefault(); if (busy) return;
      if (e.dataTransfer.files.length !== 1) { setMessage('每次请拖放一个文件'); return; }
      const file = e.dataTransfer.files[0]; if (file) upload(file);
    }}><p>拖放一个文件到此处，或使用下方选择文件。最大 20 MiB；支持 TXT、Markdown、HTML、CSV、JSON、PDF、DOCX、XLSX、PPTX。</p>
    <fieldset disabled={busy}><legend>上传本地文件</legend>
      <label>选择文件<input type="file" accept=".txt,.md,.markdown,.html,.htm,.csv,.json,.pdf,.docx,.xlsx,.pptx" onChange={(e) => {
        const file = e.target.files?.[0]; e.target.value = ''; if (file) upload(file);
      }} /></label>
    </fieldset>
    </div>
    <fieldset disabled={busy}><legend>粘贴文本</legend>
      <label>文档名称<input value={name} onChange={(e) => { setName(e.target.value); }} /></label>
      <label>文档正文<textarea rows={6} value={text} onChange={(e) => { setText(e.target.value); }} /></label>
      <button onClick={() => { void perform(async (signal) => { accepted(await request('/documents/text', signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text }) })); }); }}>导入文本</button>
    </fieldset>
    {busy && <button onClick={() => { controller.current?.abort(); setBusy(false); setMessage('请求已停止；导入可能已被接受，请刷新核对。取消已接受任务请使用任务取消按钮。'); }}>停止请求</button>}
    <p role="status">{message}</p>
    <h2>文档列表</h2><button onClick={() => { setRefresh((v) => v + 1); }}>刷新列表</button>
    <label>按名称过滤<input value={filter} maxLength={255} onChange={e => { setFilter(e.target.value); setOffset(0); }} /></label>
    <label>按状态过滤<select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setOffset(0); }}><option value="">全部状态</option>{DocumentStatusSchema.options.map(status => <option key={status} value={status}>{labels[status]}</option>)}</select></label>
    <p>共 {listing?.total ?? 0} 个文档</p>
    <table><thead><tr><th>名称</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {listing?.items.map((doc) => <tr key={doc.id}><td>{doc.name}</td><td>{labels[doc.status] ?? doc.status}</td><td><button onClick={() => { void perform(async (signal) => {
        const value = DocumentDetailSchema.parse(await request(`/documents/${doc.id}`, signal)); setDetail(value); setPreview('');
      }); }}>查看 {doc.name}</button></td></tr>)}
    </tbody></table>
    <button disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 10)); }}>上一页</button>
    <button disabled={!listing || offset + 10 >= listing.total} onClick={() => { setOffset(offset + 10); }}>下一页</button>
    {detail && <section aria-label="任务详情"><h2>任务详情：{detail.document.name}</h2>
      <p>状态：{labels[detail.job?.status ?? detail.document.status] ?? detail.document.status}</p>
      <p>当前阶段：{detail.job?.phase ?? detail.document.status} · 尝试次数：{detail.job?.attempt ?? 0} · 配置版本：{detail.job?.configRevision ?? 0}</p>
      {detail.job?.error && <p role="alert">{detail.job.errorCode}：{detail.job.error}</p>}
      {detail.job?.warnings?.map((w, i) => <p key={`${w.code}-${String(i)}`}>{w.message}</p>)}
      {detail.job && <>
        <button disabled={busy || ['processed', 'failed', 'cancelled', 'interrupted'].includes(detail.job.status)} onClick={() => { void perform(async (signal) => { await request(`/jobs/${detail.job!.id}/cancel`, signal, { method: 'POST' }); setMessage('已请求取消任务'); }); }}>取消任务</button>
        <button disabled={busy || !['failed', 'cancelled', 'interrupted', 'awaiting_configuration', 'awaiting_indexing'].includes(detail.job.status)} onClick={() => { void perform(async (signal) => { accepted(await request(`/documents/${detail.document.id}/retry`, signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedJobId: detail.job!.id }) })); }); }}>重试任务</button>
      </>}
      {detail.job?.result && <><p>解析块：{detail.job.result.blocks} · 文本块：{detail.job.result.chunks}</p><button disabled={busy} onClick={() => { void perform(async (signal) => {
        const result = await request(`/documents/${detail.document.id}/parsed`, signal) as { text: string; previewTruncated: boolean };
        setPreview(result.text + (result.previewTruncated ? '\n（预览已截断，原始解析产物完整保存）' : ''));
      }); }}>查看解析正文</button></>}
      {preview && <pre aria-label="解析正文">{preview}</pre>}
    </section>}
    <MaintenancePanel document={detail?.document??null} onChanged={()=>{setRefresh((v)=>v+1);}} onDeleted={()=>{setDetail(null);setRefresh((v)=>v+1);}} />
  </section>;
}
