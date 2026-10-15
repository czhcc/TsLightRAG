import { useEffect, useState } from 'react';
import type { Health, ModelSettings } from '@tslightrag/contracts';
import { applicationApi } from './api/client.js';
import type { ApplicationApi } from './api/client.js';

type Status = { kind: 'loading' } | { kind: 'error' }
  | { kind: 'ready'; health: Health; settings: ModelSettings };

export function App({ api = applicationApi }: { api?: ApplicationApi }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
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
        <a href="/" aria-current={!modelsPage ? 'page' : undefined}>工作台</a>
        <a href="/settings/models" aria-current={modelsPage ? 'page' : undefined}>模型设置</a>
      </nav>
      <p className="sidebar-note">S01 · 工程与测试基座<br />应用功能正在按阶段实现。</p>
    </aside>
    <main>
      <header><span className="eyebrow">LOCAL KNOWLEDGE WORKSPACE</span><span className="badge">开发阶段 S01</span></header>
      <h1>{modelsPage ? '模型设置' : '让知识有据可循'}</h1>
      <p className="intro">{modelsPage ? '文本、向量与重排模型将通过界面独立配置。' : '从本地文档构建知识图谱，检索证据，再生成带来源的回答。'}</p>
      {status.kind === 'loading' && <p role="status">正在检查服务状态…</p>}
      {status.kind === 'error' && <section role="alert" className="notice">
        <h2>无法读取服务状态</h2><p>请确认服务端正在运行，然后重试。</p>
        <button onClick={() => { setAttempt((value) => value + 1); }}>重新检查</button>
      </section>}
      {status.kind === 'ready' && <>
        <section className="notice" aria-label="当前可用状态">
          <h2>服务已启动，知识库尚未就绪</h2>
          <p>模型待配置；本地存储和索引尚未实现。当前仅提供工程基座，不能导入文档或执行问答。</p>
          <dl><div><dt>模型配置</dt><dd>{status.health.models.configured ? '已配置' : '待配置'}</dd></div>
            <div><dt>存储</dt><dd>{status.health.storage.initialized ? '已初始化' : '待实现（S02）'}</dd></div></dl>
        </section>
        {modelsPage ? <section aria-label="模型配置入口">
          <h2>模型角色</h2><p>模型地址、密钥保存及连接测试将在 S03 实现；当前没有预设模型，也不会发起模型请求。</p>
          <div className="cards">{[
            ['文本模型', '回答生成、实体抽取与关键词，可共享或分别绑定。'],
            ['向量模型', '为文本块、实体与关系建立统一向量空间。'],
            ['重排模型', '可选，对检索出的证据重新排序。'],
          ].map(([name, description]) => <article key={name}><span className="card-label">待配置</span><h3>{name}</h3><p>{description}</p></article>)}</div>
          <p className="muted">已保存模型：{status.settings.profiles.length} · 当前配置版本：{status.settings.revision}</p>
        </section> : <section>
          <h2>开始之前</h2><p>下一阶段先实现文件持久化存储，再接入模型配置和文档处理。</p>
          <a className="action" href="/settings/models">查看模型设置</a>
        </section>}
      </>}
      <footer>文档解析将在本机执行。使用外部模型时，相关文本将发送到你配置的接口。</footer>
    </main>
  </div>;
}
