import { expect, it } from 'vitest';
import { mergeContributions } from './merge.js';
import { parseExtraction, entityId } from './extraction.js';
import { kg } from '../../../../tests/helpers/indexing.js';
const first = { chunkId: 'c1', value: parseExtraction(JSON.stringify(kg())) };
const second = { chunkId: 'c2', value: parseExtraction(JSON.stringify(kg(true))) };
it('merges cross-document sources, descriptions and strengths; reapplying a source is a no-op', () => {
  const a = mergeContributions([first], [], []); const b = mergeContributions([second], a.nodes, a.edges);
  expect(b.nodes).toHaveLength(3); expect(b.edges).toHaveLength(2);
  expect(b.nodes.find((n) => n.id === entityId('Alpha'))?.sourceChunkIds).toEqual(['c1','c2']);
  expect(b.edges.find((e) => e.sourceChunkIds.length === 2)).toMatchObject({ weight: 5, keywords: ['collaboration','research'] });
  expect(b.descriptions.get(entityId('Alpha'))).toEqual(['Alpha develops graph systems.']);
  const repeated = mergeContributions([first, second], b.nodes, b.edges);
  expect(repeated.nodes).toEqual(b.nodes); expect(repeated.edges).toEqual(b.edges); expect(repeated.descriptions.size).toBe(0);
});
it('floors by distinct evidence count after summing new-source strengths, preserving weights above the floor', () => {
  const a = structuredClone(first); const b = structuredClone(first); b.chunkId = 'c2';
  a.value.relationships[0]!.strength = 0.2; b.value.relationships[0]!.strength = 3;
  expect(mergeContributions([a,b], [], []).edges[0]?.weight).toBe(3.2);
  b.value.relationships[0]!.strength = 0.2;
  expect(mergeContributions([a,b,a], [], []).edges[0]?.weight).toBe(2);
});
