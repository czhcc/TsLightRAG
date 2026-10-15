import { expect, it } from 'vitest';
import { MemoryVectors } from './vectors.js';

const space = { id: 'space-v1', dimensions: 2, normalization: 'l2' as const };
const row = (id: string, values: number[]) => ({ id, values, contentHash: 'a'.repeat(64), metadata: { source: 'fixture' } });
it('normalizes, returns exact cosine/top-k and uses stable ID ties', () => {
  const vectors = new MemoryVectors(space);
  for (const [id, values] of [['z', [3, 4]], ['a', [3, 4]], ['negative', [-3, -4]], ['orthogonal', [4, -3]]] as const) vectors.set(row(id, [...values]), space.id);
  expect(vectors.search([3, 4], { spaceId: space.id, topK: 2 }).map((hit) => hit.id)).toEqual(['a', 'z']);
  expect(vectors.search([3, 4], { spaceId: space.id, topK: 10, threshold: 0.5 })).toHaveLength(2);
  expect(vectors.search([3, 4], { spaceId: space.id, topK: 10 }).at(-1)?.score).toBeCloseTo(-1, 6);
  expect(vectors.search([3, 4], { spaceId: space.id, topK: 0 })).toEqual([]);
  expect(vectors.get('a')?.values).toBeInstanceOf(Float32Array);
});
it.each([{ values: [0, 0] }, { values: [1] }, { values: [NaN, 1] }, { values: [Infinity, 1] }])('rejects invalid vector %j', ({ values }) => {
  const vectors = new MemoryVectors(space);
  expect(() => vectors.set(row('x', values), space.id)).toThrow();
  expect(() => vectors.search(values, { spaceId: space.id, topK: 2 })).toThrow();
});
it('validates spaces, top-k and thresholds even for empty data', () => {
  const vectors = new MemoryVectors(space);
  expect(() => vectors.set(row('x', [1, 0]), 'different')).toThrow('space');
  expect(() => vectors.search([1, 0], { spaceId: 'different', topK: 2 })).toThrow('space');
  for (const topK of [-1, 1.5, NaN]) expect(() => vectors.search([1, 0], { spaceId: space.id, topK })).toThrow();
  expect(() => vectors.search([1, 0], { spaceId: space.id, topK: 2, threshold: 2 })).toThrow();
  expect(new MemoryVectors(space).search([1, 0], { spaceId: space.id, topK: 2 })).toEqual([]);
});
it('JSON round-trips float32 without accumulating reload drift', () => {
  let vectors = new MemoryVectors(space); const input = row('x', [1, 3]);
  vectors.set(input, space.id); input.values[0] = 999;
  const first = vectors.serialize();
  const escaped = vectors.get('x'); if (escaped) escaped.values[0] = 99;
  for (let count = 0; count < 20; count++) vectors = MemoryVectors.restore(JSON.parse(JSON.stringify(vectors.serialize())));
  expect(vectors.serialize()).toEqual(first);
  expect(vectors.get('x')?.values[0]).toBeCloseTo(1 / Math.sqrt(10), 6);
  expect(() => MemoryVectors.restore({ space, rows: [row('bad', [10, 0])] })).toThrow('normalized');
  expect(vectors.delete('x')).toBe(true); expect(vectors.size).toBe(0);
});
