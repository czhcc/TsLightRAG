import { expect, it } from 'vitest';
import { MemoryKV } from './kv.js';

it('stores Unicode and isolates both incoming and outgoing values', () => {
  const kv = new MemoryKV(); const value = { text: '中文 🧮', list: [1, 2] };
  kv.set('doc-1', value); value.list.push(3);
  const result = kv.get('doc-1') as typeof value; result.list.push(9);
  expect(kv.get('doc-1')).toEqual({ text: '中文 🧮', list: [1, 2] });
  const entries = kv.entries(); entries.pop();
  expect(kv.size).toBe(1); expect(kv.get('missing')).toBeUndefined();
  expect(kv.delete('doc-1')).toBe(true); expect(kv.delete('doc-1')).toBe(false);
});
it('preserves map keys without prototype pollution or duplicate restores', () => {
  const kv = new MemoryKV(); kv.set('__proto__', { safe: true });
  const copy = MemoryKV.restore(kv.entries(), (value) => value);
  expect(copy.get('__proto__')).toEqual({ safe: true });
  expect(() => MemoryKV.restore([['a', 1], ['a', 2]], (value) => value)).toThrow('Duplicate');
});
it('rejects non-JSON numbers and unsafe or oversized keys', () => {
  const kv = new MemoryKV();
  expect(() => kv.set('a', NaN)).toThrow();
  expect(() => kv.set('../escape', 1)).toThrow();
  expect(() => kv.set('a'.repeat(129), 1)).toThrow();
});
