import { expect, it } from 'vitest';
import type { GraphData } from '@tslightrag/contracts';
import { graphLayout } from './graph-layout.js';
import { mergeGraph } from './GraphViewer.js';
const node = (id: string) => ({ id, name: id, type: 'concept', description: id, sourceCount: 1 });
const edge = (id: string, sourceId: string, targetId: string) => ({ id, sourceId, targetId, description: id, sourceCount: 1, keywords: [], weight: 1 });
const graph = (ids: string[], edges: GraphData['edges'] = []): GraphData => ({ nodes: ids.map(node), edges, corpusRevision: 1, totalNodes: 600, totalEdges: 2000, matchedNodes: ids.length, truncated: false });
it('accumulates and updates unique objects without dropping previous results or retaining dangling edges', () => {
  const initial = graph(['a', 'b'], [edge('ab', 'a', 'b')]);
  const next = graph(['b', 'c'], [edge('bc', 'b', 'c'), edge('broken', 'c', 'missing')]);
  next.nodes[0]!.description = 'updated';
  const result = mergeGraph(initial, next);
  expect(result.nodes.map(n => n.id)).toEqual(['a', 'b', 'c']);
  expect(result.nodes[1]?.description).toBe('updated'); expect(initial.nodes[1]?.description).toBe('b');
  expect(result.edges.map(e => e.id)).toEqual(['ab', 'bc']);
  expect(mergeGraph(result, graph([])).nodes).toEqual(result.nodes);
});
it('bounds accumulated exploration without replacing the first results', () => {
  let result: GraphData | null = null;
  for (let batch = 0; batch < 6; batch++) result = mergeGraph(result, graph(Array.from({ length: 100 }, (_, i) => `n${String(batch * 100 + i)}`)));
  expect(result!.nodes).toHaveLength(500); expect(result!.nodes[0]?.id).toBe('n0'); expect(result!.truncated).toBe(true);
  const links = Array.from({ length: 1600 }, (_, i) => edge(`e${String(i)}`, 'n0', 'n1'));
  for (let start = 0; start < links.length; start += 300) result = mergeGraph(result, graph(['n0', 'n1'], links.slice(start, start + 300)));
  expect(result!.edges).toHaveLength(1500);
});
it.each(['force', 'circle', 'grid', 'hierarchy'] as const)('produces deterministic finite %s positions for cycles, disconnected nodes and empty inputs', layout => {
  const data = graph(['a', 'b', 'c', 'isolated'], [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a'), edge('bad', 'a', 'missing')]);
  const positions = graphLayout(data.nodes, data.edges, layout);
  expect(positions).toEqual(graphLayout(data.nodes, data.edges, layout)); expect(positions.size).toBe(4);
  for (const point of positions.values()) {
    expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(1000);
    expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(650);
  }
  expect(new Set([...positions.values()].map(p => `${String(p.x)},${String(p.y)}`)).size).toBe(4);
  expect(graphLayout([], [], layout).size).toBe(0);
  expect(graphLayout([node('a')], [], layout).get('a')).toEqual({ x: 500, y: 325 });
});
