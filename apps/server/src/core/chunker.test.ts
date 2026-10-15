import { expect, it } from 'vitest';
import { chunkDocument } from './chunker.js';
import { countTokens } from './tokenizer.js';
import { parseDocument, prepareDocument } from '../parsers/index.js';
import { documentFixture } from '../../../../tests/helpers/document-fixtures.js';
it.each(['cl100k_base', 'o200k_base'] as const)('counts fixed local %s encoding and treats special-token syntax as text', (encoding) => {
  expect(countTokens('hello world', encoding)).toBe(2);
  expect(countTokens('<|endoftext|>', encoding)).toBeGreaterThan(1);
  expect(countTokens('中文 🧮', encoding)).toBeGreaterThan(1);
});
it.each([['English words and punctuation. '.repeat(30), 9], ['中文知识图谱及证据 🧮 👩‍💻 '.repeat(25), 8], ['𠮷🧮'.repeat(20), 6]] as const)('bounds windows without Unicode loss %#', async (text, windowTokens) => {
  const doc = await parseDocument(Buffer.from(text), 'text.txt');
  const chunks = chunkDocument(doc, { docId: 'doc-1', docVersion: 1, windowTokens, overlapTokens: 0 });
  expect(chunks.map((c) => c.content).join('')).toBe(doc.text);
  for (const [i, c] of chunks.entries()) { expect(c.order).toBe(i); expect(c.tokens).toBe(countTokens(c.content)); expect(c.tokens).toBeLessThanOrEqual(windowTokens); expect(c.content).not.toContain('�'); expect(doc.text.slice(c.start, c.end)).toBe(c.content); }
});
it('preserves the tail, overlap, stable IDs and source block locations', async () => {
  const doc = await parseDocument(await documentFixture('sample.md'), 'sample.md'); const options = { docId: 'doc-1', docVersion: 1, windowTokens: 12, overlapTokens: 3 };
  const chunks = chunkDocument(doc, options); expect(chunkDocument(doc, options)).toEqual(chunks);
  expect(chunks.at(-1)?.end).toBe(doc.text.length); expect(chunks[0]?.start).toBe(0);
  for (let i = 1; i < chunks.length; i++) { expect(chunks[i]!.start).toBeGreaterThan(chunks[i - 1]!.start); expect(chunks[i]!.start).toBeLessThanOrEqual(chunks[i - 1]!.end); }
  expect(chunks.flatMap((c) => c.locations).some((l) => l.location.headingPath?.includes('数据'))).toBe(true);
  expect(chunkDocument(doc, { ...options, docVersion: 2 })[0]?.id).not.toBe(chunks[0]?.id);
  expect(chunkDocument(doc, { ...options, docId: 'doc-2' })[0]?.id).not.toBe(chunks[0]?.id);
});
it.each([{ windowTokens: 0 }, { windowTokens: 10, overlapTokens: 10 }, { windowTokens: 2, overlapTokens: 3 }, { overlapTokens: -1 }, { windowTokens: 1.5 }])('rejects invalid window/overlap %#', async (patch) => {
  const doc = await parseDocument(Buffer.from('text'), 'text.txt');
  expect(() => chunkDocument(doc, { docId: 'd', docVersion: 1, ...patch })).toThrow();
});
it('handles one-token ASCII windows, rejects too-small Unicode windows and invalid/empty input', async () => {
  const doc = await parseDocument(Buffer.from('a b c d'), 'a.txt'); expect(chunkDocument(doc, { docId: 'd', docVersion: 1, windowTokens: 1, overlapTokens: 0 }).map((c) => c.content).join('')).toBe(doc.text);
  const emoji = await parseDocument(Buffer.from('🧮'), 'e.txt'); expect(() => chunkDocument(emoji, { docId: 'd', docVersion: 1, windowTokens: 1, overlapTokens: 0 })).toThrow('Unicode');
  expect(() => chunkDocument({ ...doc, text: '' }, { docId: 'd', docVersion: 1 })).toThrow();
  expect(() => chunkDocument({ ...doc, blocks: [{ ...doc.blocks[0]!, end: 999 }] }, { docId: 'd', docVersion: 1 })).toThrow();
});
it.each(['cl100k_base', 'o200k_base'] as const)('performs parsing and %s chunking inside the worker using the same counter', async (encoding) => {
  const prepared = await prepareDocument(await documentFixture('sample.txt'), 'sample.txt', { docId: 'd', docVersion: 1, windowTokens: 10, overlapTokens: 2, encoding });
  expect(prepared.chunks).toEqual(chunkDocument(prepared.document, { docId: 'd', docVersion: 1, windowTokens: 10, overlapTokens: 2, encoding }));
});
