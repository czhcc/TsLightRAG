import { useEffect, useRef, useState } from 'react';
import { ApiErrorSchema, GraphCatalogSchema } from '@tslightrag/contracts';
import type { GraphCatalog as CatalogPage } from '@tslightrag/contracts';

export function GraphCatalog({ kind, refresh, busy, onAdd, onInspect }: {
  kind: 'nodes' | 'edges'; refresh: string; busy: boolean;
  onAdd: (nodeIds: string[], edgeIds: string[]) => void;
  onInspect: (kind: 'node' | 'edge', id: string) => void;
}) {
  const label = kind === 'nodes' ? '实体' : '关系';
  const [data, setData] = useState<CatalogPage | null>(null), [page, setPage] = useState(0), [size, setSize] = useState(10);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const revision = useRef<number | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void (async () => {
      try {
        const params = new URLSearchParams({ kind, offset: String(page * size), limit: String(size) });
        const response = await fetch(`/api/v1/graph/catalog?${params}`, { signal: controller.signal });
        const payload: unknown = await response.json();
        if (!response.ok) { const parsed = ApiErrorSchema.safeParse(payload); throw new Error(parsed.success ? parsed.data.message : '图谱列表加载失败'); }
        const value = GraphCatalogSchema.parse(payload);
        if (value.kind !== kind) throw new Error('图谱列表类型不匹配');
        if (controller.signal.aborted) return;
        if (revision.current !== undefined && revision.current !== value.corpusRevision) setChecked(new Set());
        revision.current = value.corpusRevision; setData(value);
        if (page && page * size >= value.total) setPage(Math.max(0, Math.ceil(value.total / size) - 1));
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '图谱列表加载失败'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [kind, page, size, refresh]);
  function toggle(id: string, selected: boolean) {
    if (selected && checked.size >= 100 && !checked.has(id)) { setError('每次最多选择 100 项，可分批加入关联图。'); return; }
    setError(''); setChecked(current => { const next = new Set(current); if (selected) next.add(id); else next.delete(id); return next; });
  }
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / size));
  return <section aria-label={`图谱${label}`}>
    <h2>{label}</h2><p className="muted">图谱内的全部{label}，不受上方搜索条件影响。</p>
    <div className="graph-catalog-actions"><button disabled={busy || loading || !checked.size} onClick={() => onAdd(kind === 'nodes' ? [...checked] : [], kind === 'edges' ? [...checked] : [])}>将所选{label}加入关联图</button>
      <button className="secondary" disabled={!checked.size} onClick={() => setChecked(new Set())}>取消选择{label}</button><span>已选 {checked.size} 项</span></div>
    {error && <p role="alert">{error}</p>}{loading && <p className="muted">正在加载{label}列表…</p>}
    <div className="graph-table"><table><thead><tr><th>选择</th><th>{kind === 'nodes' ? '名称' : '关系'}</th><th>{kind === 'nodes' ? '类型' : '关键词'}</th><th>{kind === 'nodes' ? '来源数' : '权重'}</th></tr></thead><tbody>
      {data?.kind === 'nodes' && data.items.map(n => <tr key={n.id}><td><input type="checkbox" aria-label={`选择实体 ${n.name}`} checked={checked.has(n.id)} disabled={loading || busy} onChange={e => toggle(n.id, e.target.checked)} /></td>
        <td><button disabled={busy || loading} onClick={() => onInspect('node', n.id)}>{n.name}</button></td><td>{n.type}</td><td>{n.sourceCount}</td></tr>)}
      {data?.kind === 'edges' && data.items.map(e => <tr key={e.id}><td><input type="checkbox" aria-label={`选择关系 ${e.sourceName} ↔ ${e.targetName}`} checked={checked.has(e.id)} disabled={loading || busy} onChange={event => toggle(e.id, event.target.checked)} /></td>
        <td><button disabled={busy || loading} onClick={() => onInspect('edge', e.id)}>{e.sourceName} ↔ {e.targetName}</button></td><td>{e.keywords.join('、')}</td><td>{e.weight}</td></tr>)}
      {data?.total === 0 && <tr><td colSpan={4}>知识图谱中暂无{label}。</td></tr>}
    </tbody></table></div>
    <div className="graph-pagination"><label htmlFor={`graph-size-${kind}`}>每页行数</label><select id={`graph-size-${kind}`} aria-label={`${label}每页行数`} value={size} disabled={loading} onChange={e => { setSize(Number(e.target.value)); setPage(0); }}>{[10, 20, 50, 100].map(n => <option key={n} value={n}>{n} 行/页</option>)}</select>
      <span>共 {data?.total ?? 0} 条 · 第 {page + 1} / {pages} 页</span>
      <button disabled={loading || page === 0} onClick={() => setPage(page - 1)}>上一页{label}</button><button disabled={loading || page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页{label}</button>
    </div>
  </section>;
}
