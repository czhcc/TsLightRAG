import { useEffect, useRef, useState } from 'react';
import { ApiErrorSchema, ChatSettingsSchema, ConversationListSchema, ConversationSchema } from '@tslightrag/contracts';
import type { Conversation, ConversationSummary, ChatSettings } from '@tslightrag/contracts';
import { SafeMarkdown } from './SafeMarkdown.js';
import { readNdjson } from './api/ndjson.js';

async function request(path: string, signal: AbortSignal, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/v1/conversations${path}`, { method, signal,
    headers: { Accept: 'application/json, application/x-ndjson', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(await response.json());
    throw new Error(error.success ? error.data.message : '对话请求失败');
  }
  return response;
}
const statusLabels = { generating: '正在生成…', completed: '回答完成', failed: '回答失败', cancelled: '已停止，回答可能不完整', interrupted: '服务中断，回答未完成' };

export function KnowledgeChat() {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [settings, setSettings] = useState<ChatSettings>(() => ChatSettingsSchema.parse({}));
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [streamReady, setStreamReady] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const selection = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const generating = conversation?.turns.at(-1)?.status === 'generating';

  async function list(signal: AbortSignal) {
    const result = ConversationListSchema.parse(await (await request('', signal)).json());
    if (!signal.aborted) setItems(result);
    return result;
  }
  function select(c: Conversation) {
    setConversation(c); setSettings(c.settings); setQuestion('');
    window.history.replaceState({}, '', `/chat?conversation=${encodeURIComponent(c.id)}`);
  }
  async function open(id: string) {
    selection.current?.abort(); const controller = new AbortController(); selection.current = controller;
    setLoading(true); setError('');
    try { const c = ConversationSchema.parse(await (await request(`/${id}`, controller.signal)).json()); if (!controller.signal.aborted) select(c); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '加载对话失败'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController(); selection.current = controller;
    void (async () => {
      try {
        const rows = await list(controller.signal);
        const requested = new URLSearchParams(window.location.search).get('conversation');
        const id = rows.find(c => c.id === requested)?.id ?? rows[0]?.id;
        if (id) { const c = ConversationSchema.parse(await (await request(`/${id}`, controller.signal)).json()); if (!controller.signal.aborted) select(c); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '加载历史失败'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); selection.current?.abort(); pending.current?.abort(); };
  }, []);
  const conversationId = conversation?.id;
  useEffect(() => {
    if (!conversationId || !generating || busy) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void request(`/${conversationId}`, controller.signal).then(r => r.json()).then(async value => {
        if (!controller.signal.aborted) {
          const c = ConversationSchema.parse(value);
          if (c.turns.at(-1)?.status !== 'generating') await list(controller.signal).catch(() => {});
          if (!controller.signal.aborted) setConversation(c);
        }
      }).catch(() => {});
    }, 1500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [conversationId, generating, busy]);
  useEffect(() => { bottom.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }); }, [conversation?.turns]);

  async function create() {
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try { const c = ConversationSchema.parse(await (await request('', controller.signal, 'POST', {})).json()); select(c); await list(controller.signal); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '新建对话失败'); }
    finally { if (!controller.signal.aborted) { setBusy(false); pending.current = null; } }
  }
  async function remove() {
    if (!conversation || !window.confirm('删除这段对话及其问答记录？')) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      await request(`/${conversation.id}`, controller.signal, 'DELETE');
      setConversation(null); window.history.replaceState({}, '', '/chat');
      const rows = await list(controller.signal); if (rows[0]) await open(rows[0].id);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '删除对话失败'); }
    finally { if (!controller.signal.aborted) { setBusy(false); pending.current = null; } }
  }
  async function send() {
    if (!conversation || !question.trim() || busy || generating) return;
    const captured = conversation, text = question.trim(), controller = new AbortController();
    pending.current = controller; setBusy(true); setStreamReady(false); setError(''); setQuestion('');
    setConversation({ ...captured, turns: [...captured.turns, { id: 'pending', question: text, answer: '',
      createdAt: new Date().toISOString(), status: 'generating', references: [], warnings: [], settings }] });
    try {
      const response = await request(`/${captured.id}/messages`, controller.signal, 'POST', {
        expectedRevision: captured.revision, question: text, settings,
      });
      if (!controller.signal.aborted) setStreamReady(true);
      await readNdjson(response, event => {
        if (controller.signal.aborted) return;
        setConversation(current => {
          if (!current || current.id !== captured.id) return current;
          const turns = [...current.turns], turn = { ...turns[turns.length - 1]! };
          if (event.type === 'references') turn.references = event.references;
          if (event.type === 'delta') turn.answer += event.text;
          if (event.type === 'done') { turn.status = 'completed'; turn.finishReason = event.finishReason; turn.warnings = event.warnings; }
          if (event.type === 'error') { turn.status = 'failed'; turn.error = event.error.message; }
          if (event.type === 'cancelled') turn.status = 'cancelled';
          turns[turns.length - 1] = turn; return { ...current, turns };
        });
      });
    } catch (e) {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : '回答请求失败'); setQuestion(text); }
    } finally {
      if (!controller.signal.aborted) {
        try { const c = ConversationSchema.parse(await (await request(`/${captured.id}`, controller.signal)).json()); setConversation(c); await list(controller.signal); }
        catch { setError('无法确认对话保存状态，请重新加载后查看历史记录'); }
        setBusy(false); setStreamReady(false); pending.current = null;
      }
    }
  }
  async function stop() {
    if (!conversation) return;
    try { await request(`/${conversation.id}/cancel`, new AbortController().signal, 'POST', {}); }
    catch (e) { setError(e instanceof Error ? e.message : '停止回答失败'); }
  }
  return <section className="knowledge-chat" aria-label="知识问答">
    <div className="chat-history" aria-label="历史对话">
      <div className="chat-history-heading"><h2>历史对话</h2><button disabled={busy || loading || generating} onClick={() => { void create(); }}>新建对话</button></div>
      {loading && <p role="status">正在加载对话…</p>}
      {!loading && !items.length && <p className="muted">还没有对话，新建后即可提问。</p>}
      <ul>{items.map(c => <li key={c.id}><button disabled={busy || loading} aria-current={conversation?.id === c.id ? 'true' : undefined}
        onClick={() => { void open(c.id); }}><span>{c.title}</span><small>{new Date(c.updatedAt).toLocaleString()}{c.status === 'generating' ? ' · 生成中' : ''}</small></button></li>)}</ul>
    </div>
    <div className="chat-panel">
      <div className="chat-panel-heading"><h2>{conversation?.title ?? '开始知识库对话'}</h2>{conversation && <button className="secondary" disabled={busy || generating || loading} onClick={() => { void remove(); }}>删除对话</button>}</div>
      {error && <p role="alert">{error}</p>}
      <fieldset className="chat-options" disabled={busy || generating || loading || !conversation}><legend>检索选项</legend>
        <div><label htmlFor="chat-mode">检索模式</label><select id="chat-mode" value={settings.mode} onChange={e => { setSettings({ ...settings, mode: e.target.value as ChatSettings['mode'] }); }}>{['naive', 'local', 'global', 'hybrid', 'mix'].map(m => <option key={m}>{m}</option>)}</select></div>
        <div><label htmlFor="chat-method">来源块选择</label><select id="chat-method" value={settings.kgChunkPickMethod} onChange={e => { setSettings({ ...settings, kgChunkPickMethod: e.target.value as ChatSettings['kgChunkPickMethod'] }); }}><option>VECTOR</option><option>WEIGHT</option></select></div>
        <div><label htmlFor="chat-related">关联块数量</label><input id="chat-related" type="number" min="0" max="100" value={settings.relatedChunkNumber} onChange={e => { setSettings({ ...settings, relatedChunkNumber: Number(e.target.value) }); }} /></div>
        <label className="chat-checkbox"><input type="checkbox" checked={settings.enableRerank} onChange={e => { setSettings({ ...settings, enableRerank: e.target.checked }); }} />启用重排</label>
      </fieldset>
      <div className="chat-messages" aria-label="问答记录" aria-busy={Boolean(generating)}>
        {!conversation?.turns.length && <div className="chat-empty"><h3>向知识库提问</h3><p>回答将结合文档证据，支持继续追问并查看来源。</p></div>}
        {conversation?.turns.map((turn, i) => <div className="chat-turn" key={turn.id}>
          <article className="chat-question" aria-label={`问题 ${String(i + 1)}`}><strong>你</strong><p>{turn.question}</p></article>
          <article className="chat-answer" aria-label={`回答 ${String(i + 1)}`}><strong>知识库助手</strong>
            <SafeMarkdown content={turn.answer} /><p className="muted" role={turn.status === 'generating' ? 'status' : undefined}>{statusLabels[turn.status]}</p>
            {turn.error && <p role="alert">{turn.error}</p>}{turn.warnings.map((w, n) => <p className="muted" key={n}>{w}</p>)}
            {!!turn.references.length && <details><summary>查看来源（{String(turn.references.length)}）</summary><ul>{turn.references.map(r => <li key={r.id}><a href={`/documents?id=${encodeURIComponent(r.documentId)}`}>[{r.id}] {r.fileName}</a></li>)}</ul></details>}
          </article>
        </div>)}<div ref={bottom} />
      </div>
      <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <label htmlFor="chat-question">输入问题</label><textarea id="chat-question" rows={3} maxLength={20000} value={question}
          disabled={!conversation || busy || generating || loading} placeholder="针对知识库提问，或继续追问…" onChange={e => { setQuestion(e.target.value); }} />
        <div className="chat-composer-actions"><span className="muted">对话记录保存在当前服务，刷新后可继续查看。</span>
          {generating ? <button type="button" disabled={busy && !streamReady} onClick={() => { void stop(); }}>停止生成</button>
            : <button type="submit" disabled={!conversation || busy || loading || !question.trim()}>发送问题</button>}</div>
      </form>
    </div>
  </section>;
}
