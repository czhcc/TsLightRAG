import { expect, it } from 'vitest';
import { MemoryGraph, edgeId } from './graph.js';

const node = (id: string) => ({ id, name: id, type: 'concept', description: '中文', sourceChunkIds: ['c1'] });
const edge = (sourceId: string, targetId: string) => ({ sourceId, targetId, description: '关联', keywords: ['关系'], weight: 2, sourceChunkIds: ['c1'] });
it('canonicalizes undirected edges without ambiguous pair keys', () => {
  const graph = new MemoryGraph(); graph.setNode(node('a')); graph.setNode(node('b'));
  const id = graph.setEdge(edge('b', 'a'));
  expect(id).toBe(edgeId('a', 'b')); expect(graph.getEdge('a', 'b')).toEqual(graph.getEdge('b', 'a'));
  expect(edgeId('a-b', 'c')).not.toBe(edgeId('a', 'b-c'));
  expect(graph.neighbors('a')).toEqual(['b']); expect(graph.edgeDegree('a', 'b')).toBe(2);
  expect(() => graph.setEdge(edge('a', 'missing'))).toThrow('Dangling');
});
it('isolates returned data, counts self loops as NetworkX does, and removes incident edges', () => {
  const graph = new MemoryGraph(); graph.setNode(node('a')); graph.setNode(node('b'));
  graph.setEdge(edge('a', 'a')); graph.setEdge(edge('a', 'b'));
  expect(graph.degree('a')).toBe(3); expect(graph.degree('b')).toBe(1);
  const copy = graph.getNode('a'); if (copy) copy.name = 'changed';
  expect(graph.getNode('a')?.name).toBe('a');
  expect(graph.deleteNode('a')).toBe(true); expect(graph.edgeCount).toBe(0); expect(graph.neighbors('b')).toEqual([]);
});
it('rebuilds adjacency on restore and rejects corrupt canonical IDs/duplicates', () => {
  const graph = new MemoryGraph(); graph.setNode(node('a')); graph.setNode(node('b')); graph.setEdge(edge('a', 'b'));
  const restored = MemoryGraph.restore(JSON.parse(JSON.stringify(graph.serialize())));
  expect(restored.neighbors('b')).toEqual(['a']); expect(restored.serialize()).toEqual(graph.serialize());
  const file = graph.serialize(); if (file.edges[0]) file.edges[0].id = 'wrong';
  expect(() => MemoryGraph.restore(file)).toThrow('canonical');
  expect(() => MemoryGraph.restore({ nodes: [node('a'), node('a')], edges: [] })).toThrow('Duplicate');
});

it('caps dense graph browsing at 100 nodes and 300 edges without returning dangling endpoints', () => {
  const graph = new MemoryGraph();
  for (let i = 0; i < 120; i++) graph.setNode({ id: `n${i}`, name: `Node ${String(i).padStart(3, '0')}`, type: 'concept', description: 'node', sourceChunkIds: ['c'] });
  for (let i = 0; i < 30; i++) for (let j = i + 1; j < 30; j++) graph.setEdge({ sourceId: `n${i}`, targetId: `n${j}`, description: 'relation', keywords: [], weight: 1, sourceChunkIds: ['c'] });
  const data = graph.browse('', undefined, 100);
  expect(data.nodes).toHaveLength(100); expect(data.totalNodes).toBe(120); expect(data.totalEdges).toBe(435); expect(data.edges).toHaveLength(300); expect(data.truncated).toBe(true);
  const small = graph.browse('', 'n0', 2);
  expect(small.nodes[0]!.id).toBe('n0'); expect(small.nodes).toHaveLength(2); expect(small.edges).toHaveLength(1);
});
