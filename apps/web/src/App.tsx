import { useEffect, useState } from 'react';
import { PARSER_CAPABILITIES } from '@tslightrag/contracts';
import type { Health, ModelSettings } from '@tslightrag/contracts';
import { QueryPreview } from './QueryPreview.js';
import { Documents } from './Documents.js';
import { ModelSettingsEditor } from './ModelSettings.js';
import { applicationApi } from './api/client.js';
import type { ApplicationApi } from './api/client.js';

type Status = { kind: 'loading' } | { kind: 'error' }
  | { kind: 'ready'; health: Health; settings: ModelSettings };

export function App({ api = applicationApi }: { api?: ApplicationApi }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const documentsPage = window.location.pathname === '/documents';
  const queryPage = window.location.pathname === '/query';
  const modelsPage = window.location.pathname === '/settings/models';
  useEffect(() => {
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    void Promise.all([api.health(controller.signal), api.models(controller.signal)])
      .then(([health, settings]) => {
        if (!controller.signal.aborted) setStatus({ kind: 'ready', health, settings });
      }).catch(() => {
        if (!controller.signal.aborted) setStatus({ kind: 'error' });
      });
    return () => { controller.abort(); };
  }, [api, attempt]);

  return <div className="shell">
    <aside>
      <a className="brand" href="/">TsLightRAG<span>本地文档 · 图谱增强检索</span></a>
      <nav aria-label="主导航">
        <a href="/" aria-current={!modelsPage && !documentsPage && !queryPage ? 'page' : undefined}>工作台</a>
        <a href="/query" aria-current={queryPage ? 'page' : undefined}>检索预览</a>
        <a href="/documents" aria-current={documentsPage ? 'page' : undefined}>文档</a>
        <a href="/settings/models" aria-current={modelsPage ? 'page' : undefined}>模型设置</a>
      </nav>
      <p className="sidebar-note">S08 · 检索与上下文<br />应用功能正在按阶段实现。</p>
    </aside>
    <main>
      <header><span className="eyebrow">LOCAL KNOWLEDGE WORKSPACE</span><span className="badge">开发阶段 S08</span></header>
      <h1>{modelsPage ? '模型设置' : documentsPage ? '文档管理' : queryPage ? '检索预览' : '让知识有据可循'}</h1>
      <p className="intro">{modelsPage ? '独立配置文本、向量和重排接口，并测试候选连接。' : '从本地文档构建知识图谱，检索证据，再生成带来源的回答。'}</p>
      {status.kind === 'loading' && <p role="status">正在检查服务状态…</p>}
      {status.kind === 'error' && <section role="alert" className="notice">
        <h2>无法读取服务状态</h2><p>请确认服务端正在运行，然后重试。</p>
        <button onClick={() => { setAttempt((value) => value + 1); }}>重新检查</button>
      </section>}
      {status.kind === 'ready' && <>
        <section className="notice" aria-label="当前可用状态">
          <h2>服务已启动，知识库尚未就绪</h2>
          <p>本地存储已初始化，模型可在设置页配置；本地文档导入、解析和任务管理已实现；图谱索引和五模式检索预览已实现，回答生成将在 S09 接入。</p>
          <dl><div><dt>模型配置</dt><dd>{status.health.models.configured ? '已配置' : '待配置'}</dd></div>
            <div><dt>存储</dt><dd>{status.health.storage.initialized ? '已初始化' : '未就绪'}</dd></div></dl>
        </section>
        {queryPage ? <QueryPreview /> : documentsPage ? <Documents /> : modelsPage ? <ModelSettingsEditor initial={status.settings} api={api} onSaved={(settings) => {
          const missingRoles = (['query', 'embedding'] as const).filter((role) => !settings.bindings[role]);
          setStatus({ ...status, settings, health: { ...status.health, models: { configured: missingRoles.length === 0, missingRoles } } });
        }} /> : <section>
          <h2>开始之前</h2><p>可导入文档并查看真实解析进度，配置模型后可构建图谱索引并预览检索证据。</p>
          <a className="action" href="/settings/models">查看模型设置</a> <a className="action" href="/documents">管理文档</a> <a className="action" href="/query">预览检索</a>
        </section>}
        {!modelsPage && <section aria-label="本地解析能力">
          <h2>本地解析能力</h2><p>以下格式可在文档页面上传、本地解析和查看结果。</p>
          <table><thead><tr><th>格式</th><th>当前能力与限制</th></tr></thead><tbody>
            {PARSER_CAPABILITIES.formats.map((f) => <tr key={f.format}><td>{f.label}</td><td>{f.scope}</td></tr>)}
          </tbody></table>
          <p>单文件 {PARSER_CAPABILITIES.limits.inputBytes / 1024 / 1024} MiB；解压总量 {PARSER_CAPABILITIES.limits.zipBytes / 1024 / 1024} MiB；最多 {PARSER_CAPABILITIES.limits.zipEntries} 个 ZIP 项；文本 {PARSER_CAPABILITIES.limits.textChars} 字符；解析含分块限时 {PARSER_CAPABILITIES.limits.timeoutMs / 1000} 秒。</p>
          <p>不支持：{PARSER_CAPABILITIES.exclusions.join('、')}。</p>
        </section>}
      </>}
      <footer>文档解析在本机执行。使用外部模型时，相关文本将发送到你配置的接口。</footer>
    </main>
  </div>;
}
