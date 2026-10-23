import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiErrorSchema, GraphDataSchema, GraphSourcesSchema, GraphSelectionDataSchema } from '@tslightrag/contracts';
import type { GraphData, GraphSources } from '@tslightrag/contracts';
import { graphLayout, GRAPH_HEIGHT, GRAPH_WIDTH } from './graph-layout.js';
import type { GraphLayout } from './graph-layout.js';
import { GraphCatalog } from './GraphCatalog.js';

class GraphRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function get(path: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(`/api/v1/graph${path}`, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(payload);
    throw new GraphRequestError(error.success ? error.data.message : '图谱加载失败', response.status);
  }
  return payload;
}
type Selection = { kind: 'node' | 'edge'; id: string };
type Exploration = { q: string; count: number; kind: 'nodes' | 'edges'; root?: string; items?: { nodeIds: string[]; edgeIds: string[] } };
const MAX_NODES = 500, MAX_EDGES = 1500, MAX_EXPLORATIONS = 100;
export function mergeGraph(previous: GraphData | null, next: GraphData): GraphData {
  const nodes = new Map(previous?.nodes.map(n => [n.id, n]));
  for (const node of next.nodes) if (nodes.has(node.id) || nodes.size < MAX_NODES) nodes.set(node.id, node);
  const edges = new Map(previous?.edges.map(e => [e.id, e]));
  for (const edge of next.edges) if (nodes.has(edge.sourceId) && nodes.has(edge.targetId) && (edges.has(edge.id) || edges.size < MAX_EDGES)) edges.set(edge.id, edge);
  return { ...next, nodes: [...nodes.values()], edges: [...edges.values()],
    truncated: Boolean(previous?.truncated || next.truncated || next.nodes.some(n => !nodes.has(n.id)) || next.edges.some(e => !edges.has(e.id))) };
}
export function GraphViewer() {
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(50), [kind, setKind] = useState<'nodes' | 'edges'>('nodes');
  const [data, setData] = useState<GraphData | null>(null), [selected, setSelected] = useState<Selection | null>(null);
  const [layout, setLayout] = useState<GraphLayout>('force');
  const [catalogRefresh, setCatalogRefresh] = useState(0), [inspected, setInspected] = useState<GraphData | null>(null);
  const [sources, setSources] = useState<GraphSources | null>(null), [offset, setOffset] = useState(0);
  const [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null), shown = useRef<GraphData | null>(null), explorations = useRef<Exploration[]>([]);
  useEffect(() => () => pending.current?.abort(), []);
  function commit(value: GraphData) {
    shown.current = value; setData(value); setInspected(null);
    setSelected(current => current && (current.kind === 'node' ? value.nodes.some(n => n.id === current.id) : value.edges.some(e => e.id === current.id)) ? current : null);
  }
  async function load(spec?: Exploration) {
    if (busy) return;
    const existing = explorations.current;
    const duplicate = spec && existing.some(e => JSON.stringify(e) === JSON.stringify(spec));
    if (spec && !duplicate && existing.length >= MAX_EXPLORATIONS) { setError('已累计 100 次探索，请清空图谱后开始新的搜索。'); return; }
    const specs = spec && !duplicate ? [...existing, spec] : existing;
    if (!specs.length) return;
    pending.current?.abort(); const abort = new AbortController(); pending.current = abort;
    setBusy(true); setError(''); setNote('');
    const fetchGraph = async (item: Exploration) => {
      if (item.items) return GraphSelectionDataSchema.parse(await get('/selection', abort.signal, item.items));
      const params = new URLSearchParams({ q: item.q, kind: item.kind, limit: String(item.count), ...(item.root ? { nodeId: item.root } : {}) });
      try { return GraphDataSchema.parse(await get(`?${params}`, abort.signal)); }
      catch (e) { if (item.root && e instanceof GraphRequestError && e.status === 404) return null; throw e; }
    };
    try {
      const result = spec ? await fetchGraph(spec) : null;
      if (abort.signal.aborted) return;
      if (spec && !result) throw new Error('节点已不存在，请刷新图谱。');
      if (result && (!shown.current || shown.current.corpusRevision === result.corpusRevision)) {
        commit(mergeGraph(shown.current, result)); explorations.current = specs;
        if (!result.nodes.length) setNote('本次未找到匹配对象，已保留之前的探索结果。');
      } else {
        // Rebuild only the explored searches/expansions, never request the full graph.
        let combined: GraphData | null = null;
        const valid: Exploration[] = [];
        for (let i = 0; i < specs.length; i += 8) {
          const batch = specs.slice(i, i + 8), values = await Promise.all(batch.map(fetchGraph));
          for (const [index, value] of values.entries()) {
            if (!value) continue;
            if (combined && combined.corpusRevision !== value.corpusRevision) throw new Error('语料在刷新期间发生变化，请再次刷新图谱。');
            combined = mergeGraph(combined, value); valid.push(batch[index]!);
          }
        }
        if (!abort.signal.aborted && combined) { commit(combined); explorations.current = valid; setNote('已按当前知识库重新加载所有已探索结果。'); }
      }
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '图谱加载失败'); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    if (!selected) { setSources(null); return; }
    const abort = new AbortController(); setSources(null);
    const params = new URLSearchParams({ ...selected, offset: String(offset), limit: '10' });
    void get(`/sources?${params}`, abort.signal).then(value => {
      const result = GraphSourcesSchema.parse(value);
      if (!abort.signal.aborted) setSources(result);
    }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '来源加载失败'); });
    return () => abort.abort();
  }, [selected, offset, inspected?.corpusRevision, data?.corpusRevision]);
  const node = inspected?.nodes.find(n => selected?.kind === 'node' && n.id === selected.id) ?? data?.nodes.find(n => selected?.kind === 'node' && n.id === selected.id);
  const edge = inspected?.edges.find(e => selected?.kind === 'edge' && e.id === selected.id) ?? data?.edges.find(e => selected?.kind === 'edge' && e.id === selected.id);
  const points = useMemo(() => graphLayout(data?.nodes ?? [], data?.edges ?? [], layout), [data, layout]);
  const nodes = data?.nodes ?? [], edges = data?.edges ?? [];
  function select(value: Selection) { setInspected(null); setSelected(current => current?.kind === value.kind && current.id === value.id ? current : value); setOffset(0); }
  function expand(id: string) { void load({ q: '', count: limit, kind: 'nodes', root: id }); }
  function clear() {
    pending.current?.abort(); setBusy(false); shown.current = null; explorations.current = [];
    setData(null); setSelected(null); setSources(null); setError(''); setNote(''); setInspected(null); setOffset(0);
  }
  async function inspect(kind: 'node' | 'edge', id: string) {
    if (busy) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    try {
      const value = GraphSelectionDataSchema.parse(await get('/selection', controller.signal, { nodeIds: kind === 'node' ? [id] : [], edgeIds: kind === 'edge' ? [id] : [] }));
      if (!controller.signal.aborted) {
        setInspected(value); setSelected({ kind, id }); setOffset(0);
        if (!value.nodes.length && !value.edges.length) setError('对象已不存在，请刷新列表。');
      }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '属性加载失败'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section aria-label="知识图谱">
    <p>搜索结果会逐步加入关联图，双击实体可扩展一层邻居。下方表格为全部实体和关系，选中后可加入关联图；选中关系时同时加入两端实体。累计最多 500 个节点、1500 条关系。</p>
    <form className="graph-search" onSubmit={e => { e.preventDefault(); if (query.trim()) void load({ q: query.trim(), count: limit, kind }); }}>
      <div className="graph-search-field"><label htmlFor="graph-kind">搜索对象</label><select id="graph-kind" value={kind} disabled={busy} onChange={e => setKind(e.target.value as 'nodes' | 'edges')}><option value="nodes">实体</option><option value="edges">关系</option></select></div>
      <div className="graph-search-field graph-search-query"><label htmlFor="graph-query">{kind === 'nodes' ? '实体名称' : '关系关键词'}</label><input id="graph-query" value={query} maxLength={500} disabled={busy} onChange={e => setQuery(e.target.value)} /></div>
      <div className="graph-search-field"><label htmlFor="graph-limit">节点上限</label><input id="graph-limit" type="number" min={1} max={100} required value={limit} disabled={busy} onChange={e => setLimit(Number(e.target.value))} /></div>
      <div className="graph-search-actions"><button disabled={busy || !query.trim()}>搜索图谱</button><button type="button" disabled={busy} onClick={() => { setCatalogRefresh(v => v + 1); setInspected(null); setSelected(null); setSources(null); void load(); }}>刷新图谱</button></div>
    </form>
    {busy && <p role="status">正在加载图谱…</p>}{error && <p role="alert">{error}</p>}{note && <p className="muted">{note}</p>}
    {data && <p role="status">显示 {nodes.length} / {data.totalNodes} 个节点、{edges.length} / {data.totalEdges} 条关系{data.truncated && (nodes.length < data.totalNodes || edges.length < data.totalEdges) ? '（已达上限，部分结果未显示，可缩小搜索或清空图谱）' : ''}</p>}
    <div className="graph-view-toolbar"><label htmlFor="graph-layout">布局方式</label><select id="graph-layout" value={layout} onChange={e => setLayout(e.target.value as GraphLayout)}>
      <option value="force">力导向布局</option><option value="circle">环形布局</option><option value="grid">网格布局</option><option value="hierarchy">层级布局</option>
    </select><button className="secondary" type="button" disabled={!data && !busy} onClick={clear}>清空图谱</button></div>
    {!nodes.length ? <p className="graph-empty">{data ? '没有匹配的实体或关系，请调整搜索关键词。' : '请输入实体名称或关系关键词搜索，结果会逐步加入关联图。'}</p>
      : <svg className="graph" data-layout={layout} viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} role="group" aria-label="关联图">
        {edges.map(e => {
          const a = points.get(e.sourceId), b = points.get(e.targetId);
          return a && b ? <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={edge?.id === e.id ? '#b5792c' : '#79934f'} strokeWidth={edge?.id === e.id ? 4 : 2} onClick={() => select({ kind: 'edge', id: e.id })}><title>{e.description}</title></line> : null;
        })}
        {nodes.map(n => {
          const point = points.get(n.id)!;
          return <g key={n.id} role="button" tabIndex={0} aria-label={`图谱实体：${n.name}`} aria-pressed={node?.id === n.id} transform={`translate(${point.x},${point.y})`}
            onClick={() => select({ kind: 'node', id: n.id })} onDoubleClick={() => expand(n.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: 'node', id: n.id }); } }}>
            <title>{n.name}（双击扩展邻居）</title><circle r="13" fill={node?.id === n.id ? '#b5792c' : '#245347'} /><text textAnchor="middle" y="32">{n.name.length > 18 ? `${n.name.slice(0, 18)}…` : n.name}</text>
          </g>;
        })}
      </svg>}
    <div className="graph-lists">{(['nodes', 'edges'] as const).map(catalogKind => <GraphCatalog key={catalogKind} kind={catalogKind} busy={busy}
      refresh={`${String(catalogRefresh)}:${String(data?.corpusRevision ?? '')}`} onInspect={(kind, id) => { void inspect(kind, id); }}
      onAdd={(nodeIds, edgeIds) => { void load({ q: '', count: limit, kind: 'nodes', items: { nodeIds, edgeIds } }); }} />)}</div>
    {(node || edge) && <section aria-label="图谱属性"><h2>{node?.name ?? '关系属性'}</h2>
      {node && <><p>类型：{node.type}</p><button disabled={busy} onClick={() => expand(node.id)}>展开邻居</button></>}
      {edge && <p>权重：{edge.weight} · 关键词：{edge.keywords.join('、')}</p>}
      <pre>{node?.description ?? edge?.description}</pre>
      <h3>来源证据</h3>{!sources && !error && <p role="status">正在读取来源…</p>}
      {sources && sources.corpusRevision !== (inspected ?? data)?.corpusRevision ? <p role="alert">语料已变化，请刷新图谱后查看来源。</p> : sources && <>
        <p>共 {sources.total} 个来源块</p>{sources.items.map(s => <article key={s.chunk.id}><h3>{s.fileName}</h3><p>文档版本 {s.documentVersion} · 块 {s.chunk.order + 1}</p>{s.chunk.location && <details><summary>原始位置</summary><pre>{s.chunk.location}</pre></details>}<pre>{s.chunk.content}</pre><a href={`/documents?id=${encodeURIComponent(s.chunk.docId)}`}>查看来源文档</a></article>)}
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 10))}>上一页来源</button> <button disabled={offset + 10 >= sources.total} onClick={() => setOffset(offset + 10)}>下一页来源</button>
      </>}
    </section>}
  </section>;
}
