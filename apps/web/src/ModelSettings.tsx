import { useEffect, useRef, useState } from 'react';
import { ChatExtraBodySchema, ModelProfileInputSchema, SaveModelsSchema } from '@tslightrag/contracts';
import type { ModelProfileInput, ModelSettings } from '@tslightrag/contracts';
import type { ApplicationApi } from './api/client.js';

const labels = { text: '文本模型', embedding: '向量模型', rerank: '重排模型' };
function editable(settings: ModelSettings) {
  return settings.profiles.map((profile) => {
    const { hasApiKey, ...p } = profile; void hasApiKey; return p;
  });
}
export function ModelSettingsEditor({ initial, api, onSaved }: { initial: ModelSettings; api: ApplicationApi; onSaved: (value: ModelSettings) => void }) {
  const [saved, setSaved] = useState(initial);
  const [profiles, setProfiles] = useState<ModelProfileInput[]>(() => editable(initial));
  // Keep incomplete JSON editable; parse only when testing or saving.
  const [extraBodyDrafts, setExtraBodyDrafts] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState(initial.bindings);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  function update(index: number, patch: Record<string, unknown>) {
    setProfiles((all) => all.map((p, i) => i === index ? { ...p, ...patch } as ModelProfileInput : p));
    setMessage('');
  }
  function candidate(p: ModelProfileInput): ModelProfileInput {
    if (p.kind !== 'text' || extraBodyDrafts[p.id] === undefined) return p;
    const raw = extraBodyDrafts[p.id]!.trim();
    let value: unknown;
    try { value = raw ? JSON.parse(raw) as unknown : {}; }
    catch { throw new Error(`文本模型「${p.name}」的扩展参数必须是合法的 JSON 对象`); }
    const parsed = ChatExtraBodySchema.safeParse(value);
    if (!parsed.success) throw new Error('扩展参数必须是 JSON 对象（不超过 16 KiB），且不能覆盖模型、消息、温度、输出预算、流式或工具调用设置');
    const { extraBody, ...rest } = p; void extraBody;
    return raw ? { ...rest, extraBody: parsed.data } : rest;
  }
  function add(kind: ModelProfileInput['kind']) {
    // getRandomValues is also available on HTTP IP origins, unlike randomUUID.
    // Profile IDs are opaque identifiers; retain 128 random bits without needing
    // a secure-context-only API or falling back to Math.random.
    const random = crypto.getRandomValues(new Uint8Array(16));
    const id = `${kind}-${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const profile = ModelProfileInputSchema.parse({ id, kind, name: labels[kind],
      protocol: kind === 'rerank' ? 'cohere-compatible' : 'openai-compatible',
      endpoint: 'http://127.0.0.1:8000/v1', model: 'your-model', timeoutMs: 30000, maxConcurrency: 2,
      ...(kind === 'embedding' ? { dimensions: 1024, operatorRevision: 0 } : {}),
    });
    setProfiles((all) => [...all, profile]);
    setBindings((old) => ({ ...old, [kind === 'text' ? 'query' : kind]: old[kind === 'text' ? 'query' : kind] ?? id }));
    setMessage('');
  }
  async function perform(work: (signal: AbortSignal) => Promise<void>) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setMessage('');
    try { await work(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section aria-label="模型配置入口">
    <h2>模型角色</h2>
    <p>此页编辑候选配置。活动索引的模型版本与凭据独立保留，清除候选密钥不会删除仍被索引或任务引用的旧版本。</p>
    <p>配置保存在本机。连接测试会将示例文本发送到候选地址，并使用当前最大输出 token 设置，可能产生费用；不会保存设置或修改索引。</p>
    <p>密钥输入留空表示保留；切换地址后需重新输入或清除密钥。此处不在浏览器持久保存密钥。</p>
    <div className="cards">{Object.entries(labels).map(([kind, label]) => <article key={kind}>
      <h3>{label}</h3><button disabled={busy || profiles.length >= 100} onClick={() => { add(kind as ModelProfileInput['kind']); }}>添加{label}</button>
    </article>)}</div>
    <fieldset disabled={busy}><legend>已添加模型</legend>
      {profiles.map((p, i) => <fieldset key={p.id} aria-label={`配置 ${String(i + 1)}`}>
        <legend>{labels[p.kind]} · {String(i + 1)}</legend>
        <label>名称<input value={p.name} onChange={(e) => { update(i, { name: e.target.value }); }} /></label>
        <label>{p.kind === 'rerank' ? '完整重排 endpoint' : 'Base URL'}<input value={p.endpoint} onChange={(e) => { update(i, { endpoint: e.target.value }); }} /></label>
        <label>模型名称<input value={p.model} onChange={(e) => { update(i, { model: e.target.value }); }} /></label>
        <label>API key（{saved.profiles.find((s) => s.id === p.id)?.hasApiKey ? '已保存' : '未保存'}）
          <input type="password" autoComplete="new-password" value={p.apiKey ?? ''} onChange={(e) => { update(i, { apiKey: e.target.value || undefined }); }} /></label>
        <label><input type="checkbox" checked={p.apiKey === null} onChange={(e) => { update(i, { apiKey: e.target.checked ? null : undefined }); }} />清除密钥</label>
        <label>超时 ms<input type="number" min="100" max="600000" value={p.timeoutMs} onChange={(e) => { update(i, { timeoutMs: Number(e.target.value) }); }} /></label>
        <label>最大并发<input type="number" min="1" max="32" value={p.maxConcurrency} onChange={(e) => { update(i, { maxConcurrency: Number(e.target.value) }); }} /></label>
        <label>最大重试<input type="number" min="0" max="5" value={p.maxRetries} onChange={(e) => { update(i, { maxRetries: Number(e.target.value) }); }} /></label>
        <label>重试基准 ms<input type="number" min="1" max="10000" value={p.retryBaseMs} onChange={(e) => { update(i, { retryBaseMs: Number(e.target.value) }); }} /></label>
        <label>退避上限 ms<input type="number" min="1" max="30000" value={p.maxRetryDelayMs} onChange={(e) => { update(i, { maxRetryDelayMs: Number(e.target.value) }); }} /></label>
        {p.kind === 'text' && <>
          <label>温度<input type="number" min="0" max="2" step="0.1" value={p.temperature} onChange={(e) => { update(i, { temperature: Number(e.target.value) }); }} /></label>
          <label>最大输出 token<input type="number" value={p.maxOutputTokens} onChange={(e) => { update(i, { maxOutputTokens: Number(e.target.value) }); }} /></label>
          <label>上下文 token<input type="number" value={p.contextTokens} onChange={(e) => { update(i, { contextTokens: Number(e.target.value) }); }} /></label>
          <p className="muted">上下文 token 是输入和输出共用的总容量，请按模型服务实际限制填写。检索预览和问答默认使用此容量作为总预算。</p>
          {p.maxOutputTokens < p.contextTokens
            ? <p className="muted">扣除最大输出预留后，输入预算最多 {String(p.contextTokens - p.maxOutputTokens)} token，由系统提示、问题、历史和检索证据共同使用。</p>
            : <p role="alert">最大输出 token 必须小于上下文 token，才能为提示词和检索证据留出空间；当前配置无法用于正常问答。</p>}
          <label>Tokenizer<select value={p.tokenizer} onChange={(e) => { update(i, { tokenizer: e.target.value }); }}><option>cl100k_base</option><option>o200k_base</option></select></label>
          <label htmlFor={`extra-body-${p.id}`}>扩展参数（JSON 对象）</label>
          <textarea id={`extra-body-${p.id}`} rows={6} spellCheck={false}
            placeholder={'{\n  "chat_template_kwargs": { "enable_thinking": false }\n}'}
            value={extraBodyDrafts[p.id] ?? (p.extraBody ? JSON.stringify(p.extraBody, null, 2) : '')}
            onChange={(e) => { setExtraBodyDrafts((old) => ({ ...old, [p.id]: e.target.value })); setMessage(''); }} />
          <p className="muted">参数直接加入聊天请求 JSON 顶层，适用于连接测试及使用此模型的抽取、关键词和问答。留空并保存可清除；请勿填写密钥。是否支持取决于模型服务。不能覆盖模型、消息、温度、输出预算、流式或工具调用设置。</p>
        </>}
        {p.kind === 'embedding' && <>
          <label>维度<input type="number" min="1" max="65536" value={p.dimensions} onChange={(e) => { update(i, { dimensions: Number(e.target.value) }); }} /></label>
          <label>批大小<input type="number" min="1" max="256" value={p.batchSize} onChange={(e) => { update(i, { batchSize: Number(e.target.value) }); }} /></label>
          <label>operatorRevision<input type="number" min="0" value={p.operatorRevision} onChange={(e) => { update(i, { operatorRevision: Number(e.target.value) }); }} /></label>
          <p>同名模型更换权重时增加 operatorRevision。非空索引继续使用活动版本；保存后请到文档页重建三类向量并切换。<a href="/documents">前往索引维护</a></p>
        </>}
        {p.kind === 'rerank' && <>
          <label>协议<select value={p.protocol} onChange={(e) => { update(i, { protocol: e.target.value }); }}><option>cohere-compatible</option><option>jina-compatible</option></select></label>
          <label><input type="checkbox" checked={p.enabled} onChange={(e) => { update(i, { enabled: e.target.checked }); }} />启用重排</label>
          <label>topN<input type="number" value={p.topN} onChange={(e) => { update(i, { topN: Number(e.target.value) }); }} /></label>
          <label>失败策略<select value={p.failurePolicy} onChange={(e) => { update(i, { failurePolicy: e.target.value }); }}><option value="fail">返回错误</option><option value="fallback-with-warning">保留原顺序并警告</option></select></label>
        </>}
        <button onClick={() => { void perform(async (signal) => {
          const parsed = ModelProfileInputSchema.safeParse(candidate(p)); if (!parsed.success) throw new Error('请检查模型字段');
          const result = await api.testModel(parsed.data, saved.revision, signal); setMessage(result.message);
        }); }}>测试连接（发送示例）</button>
        <button onClick={() => { setProfiles((all) => all.filter((x) => x.id !== p.id)); setBindings((old) => Object.fromEntries(Object.entries(old).map(([role, id]) => [role, id === p.id ? null : id])) as ModelSettings['bindings']); }}>移除模型</button>
      </fieldset>)}
      <fieldset><legend>角色绑定</legend>{(['query', 'extract', 'keyword', 'embedding', 'rerank'] as const).map((role) => <label key={role}>{role}<select aria-label={`${role} 角色`} value={bindings[role] ?? ''} onChange={(e) => { setBindings((old) => ({ ...old, [role]: e.target.value || null })); }}>
        <option value="">{role === 'extract' || role === 'keyword' ? '复用 query' : '未配置 / 禁用'}</option>
        {profiles.filter((p) => p.kind === (role === 'embedding' || role === 'rerank' ? role : 'text')).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>)}</fieldset>
      <button onClick={() => { void perform(async (signal) => {
        const parsed = SaveModelsSchema.safeParse({ profiles: profiles.map(candidate), bindings, expectedRevision: saved.revision });
        if (!parsed.success) throw new Error('配置字段或角色绑定不合法');
        const result = await api.saveModels(parsed.data, signal);
        setSaved(result); setProfiles(editable(result)); setExtraBodyDrafts({}); setBindings(result.bindings); onSaved(result); setMessage('模型配置已保存');
      }); }}>保存配置</button>
      <button onClick={() => { void perform(async (signal) => { const result = await api.models(signal); setSaved(result); setProfiles(editable(result)); setExtraBodyDrafts({}); setBindings(result.bindings); onSaved(result); setMessage('已重新加载，未保存修改已丢弃'); }); }}>重新加载配置</button>
    </fieldset>
    {busy && <button onClick={() => { active.current?.abort(); setBusy(false); setMessage('操作已取消；若保存已提交，请重新加载核对版本'); }}>取消请求</button>}
    <p role="status">{message}</p>
    <p className="muted">已保存模型：{saved.profiles.length} · 当前配置版本：{saved.revision}</p>
  </section>;
}
