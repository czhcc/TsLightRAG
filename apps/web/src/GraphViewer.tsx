import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiErrorSchema, GraphDataSchema, GraphSourcesSchema } from '@tslightrag/contracts';
import type { GraphData, GraphSources } from '@tslightrag/contracts';

async function get(path: string, signal: AbortSignal) {
  const response = await fetch(`/api/v1/graph${path}`, { signal });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(payload);
    throw new Error(error.success ? error.data.message : '图谱加载失败');
  }
  return payload;
}
type Selection = { kind: 'node' | 'edge'; id: string };
export function GraphViewer() {
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(50), [kind, setKind] = useState<'nodes' | 'edges'>('nodes');
  const [data, setData] = useState<GraphData | null>(null), [selected, setSelected] = useState<Selection | null>(null);
  const [sources, setSources] = useState<GraphSources | null>(null), [offset, setOffset] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async (q: string, count: number, root?: string, searchKind: 'nodes' | 'edges' = 'nodes') => {
    pending.current?.abort(); const abort = new AbortController(); pending.current = abort;
    setBusy(true); setError(''); setSelected(null); setSources(null); setData(null);
    try {
      const params = new URLSearchParams({ q, kind: searchKind, limit: String(count), ...(root ? { nodeId: root } : {}) });
      const value = GraphDataSchema.parse(await get(`?${params}`, abort.signal));
      if (!abort.signal.aborted) setData(value);
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '图谱加载失败'); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }, []);
  useEffect(() => {
    void load('', 50);
    return () => pending.current?.abort();
  }, [load]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController(); setSources(null); setError('');
    const params = new URLSearchParams({ ...selected, offset: String(offset), limit: '10' });
    void get(`/sources?${params}`, abort.signal).then(value => {
      const result = GraphSourcesSchema.parse(value);
      if (!abort.signal.aborted) setSources(result);
    }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '来源加载失败'); });
    return () => abort.abort();
  }, [selected, offset]);
  const node = data?.nodes.find(n => selected?.kind === 'node' && n.id === selected.id);
  const edge = data?.edges.find(e => selected?.kind === 'edge' && e.id === selected.id);
  const points = new Map(data?.nodes.map((n, i, all) => [n.id, {
    x: 320 + 240 * Math.cos(2 * Math.PI * i / all.length), y: 260 + 190 * Math.sin(2 * Math.PI * i / all.length),
  }]));
  function select(value: Selection) { setSelected(value); setOffset(0); }
  return <section aria-label="知识图谱">
    <p>按实体名称或关系关键词搜索，选择节点查看属性与来源，或展开一层邻居。每次最多 100 个节点、300 条关系；展开会替换当前视图。</p>
    <form onSubmit={e => { e.preventDefault(); void load(query, limit, undefined, kind); }}>
      <label>搜索对象<select aria-label="搜索对象" value={kind} onChange={e => setKind(e.target.value as 'nodes' | 'edges')}><option value="nodes">实体</option><option value="edges">关系</option></select></label>
      <label>{kind === 'nodes' ? '实体名称' : '关系关键词'}<input value={query} maxLength={500} onChange={e => setQuery(e.target.value)} /></label>
      <label>节点上限<input type="number" min={1} max={100} required value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
      <button disabled={busy}>搜索图谱</button> <button type="button" disabled={busy} onClick={() => { setQuery(''); setKind('nodes'); void load('', limit); }}>刷新图谱</button>
    </form>
    {busy && <p role="status">正在加载图谱…</p>}{error && <p role="alert">{error}</p>}
    {data && <>
      <p role="status">显示 {data.nodes.length} / {data.totalNodes} 个节点、{data.edges.length} / {data.totalEdges} 条关系{data.truncated ? '（已达上限，请缩小搜索或展开邻居）' : ''}</p>
      {!data.nodes.length && <p>{query ? '没有匹配的实体' : '暂无图谱，请先配置模型并导入文档完成索引。'}</p>}
      {data.nodes.length > 0 && <svg className="graph" viewBox="0 0 640 520" role="img" aria-label="当前限量子图，节点操作见下方列表">
        {data.edges.map(e => {
          const a = points.get(e.sourceId), b = points.get(e.targetId);
          return a && b ? <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#79934f"><title>{e.description}</title></line> : null;
        })}
        {data.nodes.map(n => {
          const point = points.get(n.id)!;
          return <g key={n.id} transform={`translate(${point.x},${point.y})`}><circle r="12" fill="#245347" /><text textAnchor="middle" y="30">{n.name.length > 18 ? `${n.name.slice(0, 18)}…` : n.name}</text></g>;
        })}
      </svg>}
      <div className="graph-lists"><section aria-label="图谱实体"><h2>实体</h2>{data.nodes.map(n => <button key={n.id} aria-pressed={node?.id === n.id} onClick={() => select({ kind: 'node', id: n.id })}>{n.name}</button>)}</section>
        <section aria-label="图谱关系"><h2>关系</h2>{data.edges.map(e => <button key={e.id} aria-pressed={edge?.id === e.id} onClick={() => select({ kind: 'edge', id: e.id })}>{data.nodes.find(n => n.id === e.sourceId)?.name ?? e.sourceId} ↔ {data.nodes.find(n => n.id === e.targetId)?.name ?? e.targetId}</button>)}</section></div>
      {(node || edge) && <section aria-label="图谱属性"><h2>{node?.name ?? '关系属性'}</h2>
        {node && <><p>类型：{node.type}</p><button disabled={busy} onClick={() => void load('', limit, node.id)}>展开邻居</button></>}
        {edge && <p>权重：{edge.weight} · 关键词：{edge.keywords.join('、')}</p>}
        <pre>{node?.description ?? edge?.description}</pre>
        <h3>来源证据</h3>{!sources && !error && <p role="status">正在读取来源…</p>}
        {sources && sources.corpusRevision !== data.corpusRevision ? <p role="alert">语料已变化，请刷新图谱后查看来源。</p> : sources && <>
          <p>共 {sources.total} 个来源块</p>{sources.items.map(s => <article key={s.chunk.id}><h3>{s.fileName}</h3><p>文档版本 {s.documentVersion} · 块 {s.chunk.order + 1}</p>{s.chunk.location && <details><summary>原始位置</summary><pre>{s.chunk.location}</pre></details>}<pre>{s.chunk.content}</pre><a href={`/documents?id=${encodeURIComponent(s.chunk.docId)}`}>查看来源文档</a></article>)}
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 10))}>上一页来源</button> <button disabled={offset + 10 >= sources.total} onClick={() => setOffset(offset + 10)}>下一页来源</button>
        </>}
      </section>}
    </>}
  </section>;
}
