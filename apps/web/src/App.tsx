import { useEffect, useState } from 'react';
import type { Health, ModelSettings } from '@tslightrag/contracts';
import { GraphViewer } from './GraphViewer.js';
import { QueryPreview } from './QueryPreview.js';
import { KnowledgeChat } from './KnowledgeChat.js';
import { About } from './About.js';
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
  const graphPage = window.location.pathname === '/graph';
  const queryPage = window.location.pathname === '/query';
  const chatPage = window.location.pathname === '/chat';
  const modelsPage = window.location.pathname === '/settings/models';
  const aboutPage = window.location.pathname === '/about';
  useEffect(() => {
    if (aboutPage) return;
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    void Promise.all([api.health(controller.signal), api.models(controller.signal)])
      .then(([health, settings]) => {
        if (!controller.signal.aborted) setStatus({ kind: 'ready', health, settings });
      }).catch(() => {
        if (!controller.signal.aborted) setStatus({ kind: 'error' });
      });
    return () => { controller.abort(); };
  }, [api, attempt, aboutPage]);

  return <div className="shell">
    <aside>
      <a className="brand" href="/">TsLightRAG<span>本地文档 · 图谱增强检索</span></a>
      <nav aria-label="主导航">
        <a href="/" aria-current={!modelsPage && !documentsPage && !queryPage && !chatPage && !graphPage && !aboutPage ? 'page' : undefined}>工作台</a>
        <a href="/chat" aria-current={chatPage ? 'page' : undefined}>知识问答</a>
        <a href="/query" aria-current={queryPage ? 'page' : undefined}>检索预览</a>
        <a href="/graph" aria-current={graphPage ? 'page' : undefined}>知识图谱</a>
        <a href="/documents" aria-current={documentsPage ? 'page' : undefined}>文档</a>
        <a href="/settings/models" aria-current={modelsPage ? 'page' : undefined}>模型设置</a>
        <a href="/about" aria-current={aboutPage ? 'page' : undefined}>关于</a>
      </nav>
      <p className="sidebar-note">S11 · 知识库工作台<br />应用功能正在按阶段实现。</p>
    </aside>
    <main className={chatPage ? 'chat-main' : undefined}>
      <header><span className="eyebrow">LOCAL KNOWLEDGE WORKSPACE</span><span className="badge">开发阶段 S11</span></header>
      <h1>{aboutPage ? '关于' : modelsPage ? '模型设置' : documentsPage ? '文档管理' : chatPage ? '知识问答' : queryPage ? '检索预览' : graphPage ? '知识图谱' : '让知识有据可循'}</h1>
      <p className="intro">{aboutPage ? '了解系统功能、本地解析能力与使用边界。' : modelsPage ? '独立配置文本、向量和重排接口，并测试候选连接。' : '从本地文档构建知识图谱，检索证据，再生成带来源的回答。'}</p>
      {aboutPage && <About />}
      {!aboutPage && status.kind === 'loading' && <p role="status">正在检查服务状态…</p>}
      {!aboutPage && status.kind === 'error' && <section role="alert" className="notice">
        <h2>无法读取服务状态</h2><p>请确认服务端正在运行，然后重试。</p>
        <button onClick={() => { setAttempt((value) => value + 1); }}>重新检查</button>
      </section>}
      {!aboutPage && status.kind === 'ready' && <>
        {!chatPage && !documentsPage && <section className="notice" aria-label="当前可用状态">
          <h2>{status.health.usable ? '服务已就绪，可导入文档并检索问答' : '服务已启动，知识库尚未就绪'}</h2>
          <p>本地存储已初始化，模型可在设置页配置；本地文档导入、解析和任务管理已实现；图谱索引、五模式检索、流式回答和来源引用已实现。</p>
          <dl><div><dt>模型配置</dt><dd>{status.health.models.configured ? '已配置' : '待配置'}</dd></div>
            <div><dt>存储</dt><dd>{status.health.storage.initialized ? '已初始化' : '未就绪'}</dd></div></dl>
        </section>}
        {chatPage ? <KnowledgeChat /> : graphPage ? <GraphViewer /> : queryPage ? <QueryPreview /> : documentsPage ? <Documents /> : modelsPage ? <ModelSettingsEditor initial={status.settings} api={api} onSaved={(settings) => {
          const missingRoles = (['query', 'embedding'] as const).filter((role) => !settings.bindings[role]);
          setStatus({ ...status, settings, health: { ...status.health, usable: missingRoles.length === 0, models: { configured: missingRoles.length === 0, missingRoles } } });
        }} /> : <section>
          <h2>开始之前</h2><p>可导入文档并查看真实解析进度，配置模型后可构建图谱索引并预览检索证据。</p>
          <a className="action" href="/settings/models">查看模型设置</a> <a className="action" href="/documents">管理文档</a> <a className="action" href="/query">预览检索</a> <a className="action" href="/graph">浏览图谱</a>
        </section>}
      </>}
      <footer>文档解析在本机执行。使用外部模型时，相关文本将发送到你配置的接口。</footer>
    </main>
  </div>;
}
