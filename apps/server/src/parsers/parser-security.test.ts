import { expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseDocument } from './index.js';
import { documentFixture, editOffice, xmlBytes } from '../../../../tests/helpers/document-fixtures.js';
const opts = { timeoutMs: 5000 };
it.each(['../escape.xml', '/absolute.xml', 'C:/drive.xml', 'a\\b.xml'])('refuses archive path %s without extraction', async (path) => {
  const bytes = zipSync({ [path]: strToU8('<unused/>') });
  await expect(parseDocument(bytes, 'bad.docx', { limits: opts })).rejects.toBeInstanceOf(Error);
});
it('refuses symlink entries, duplicate names and encrypted ZIP flags', async () => {
  const patch = (fn: (b: Buffer, central: number) => void) => { const b = Buffer.from(zipSync({ 'a.xml': strToU8('<a/>'), 'b.xml': strToU8('<b/>') })); fn(b, b.indexOf(Buffer.from('504b0102', 'hex'))); return b; };
  const symlink = patch((b, c) => { b.writeUInt32LE((0o120777 << 16) >>> 0, c + 38); });
  const encrypted = patch((b, c) => { b.writeUInt16LE(1, c + 8); });
  const duplicate = patch((b, c) => { const second = b.indexOf(Buffer.from('504b0102', 'hex'), c + 4); b[second + 46] = 'a'.charCodeAt(0); });
  for (const bytes of [symlink, encrypted, duplicate]) await expect(parseDocument(bytes, 'bad.docx')).rejects.toBeInstanceOf(Error);
});
it('preflights advertised sizes/counts and bounds actual ZIP output', async () => {
  const bomb = zipSync({ 'unused.xml': strToU8('a'.repeat(100_000)) });
  await expect(parseDocument(bomb, 'bomb.docx', { limits: { zipBytes: 1000 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  const dishonest = Buffer.from(bomb); const central = dishonest.indexOf(Buffer.from('504b0102', 'hex')); dishonest.writeUInt32LE(1, central + 24);
  await expect(parseDocument(dishonest, 'bomb.docx', { limits: { zipEntryBytes: 1000, zipBytes: 1000 } })).rejects.toBeInstanceOf(Error);
  const count = zipSync({ a: strToU8('a'), b: strToU8('b') });
  await expect(parseDocument(count, 'count.docx', { limits: { zipEntries: 1 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
});
it('checks CRC and refuses malformed ZIP containers', async () => {
  const bytes = Buffer.from(await documentFixture('sample.docx')); const central = bytes.indexOf(Buffer.from('504b0102', 'hex')); bytes.writeUInt32LE(0, central + 16);
  await expect(parseDocument(bytes, 'bad.docx')).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  await expect(parseDocument((await documentFixture('sample.docx')).subarray(0, 60), 'bad.docx')).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
});
it('rejects XXE/entity declarations even in unused XML before format extraction', async () => {
  const bytes = await editOffice('docx', (files) => { files['unused.xml'] = xmlBytes('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>'); });
  await expect(parseDocument(bytes, 'xxe.docx')).rejects.toMatchObject({ code: 'UNSAFE_XML' });
});
it('bounds XML/JSON/HTML/Markdown depth and node budgets', async () => {
  const xml = await editOffice('docx', (files) => { files['unused.xml'] = xmlBytes('<n>'.repeat(80) + 'x' + '</n>'.repeat(80)); });
  await expect(parseDocument(xml, 'deep.docx')).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  for (const [file, text] of [['deep.json', '['.repeat(80) + '1' + ']'.repeat(80)], ['deep.html', '<div>'.repeat(80) + 'x' + '</div>'.repeat(80)], ['deep.md', '> '.repeat(80) + 'x']]) {
    await expect(parseDocument(Buffer.from(text!), file!)).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  }
  await expect(parseDocument(Buffer.from('{"a":1,"b":2}'), 'nodes.json', { limits: { nodes: 2 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
});
it('enforces input/text/block/page/row/column limits and only permits tighter policy', async () => {
  await expect(parseDocument(Buffer.alloc(11), 'x.txt', { limits: { inputBytes: 10 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  await expect(parseDocument(Buffer.from('123456'), 'x.txt', { limits: { textChars: 5 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  await expect(parseDocument(Buffer.from('a\n\nb'), 'x.txt', { limits: { blocks: 1 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  await expect(parseDocument(await documentFixture('sample.pdf'), 'x.pdf', { limits: { pages: 1 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  await expect(parseDocument(Buffer.from('a,b\nc,d'), 'x.csv', { limits: { rows: 1 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  await expect(parseDocument(Buffer.from('a,b'), 'x.csv', { limits: { columns: 1 } })).rejects.toMatchObject({ code: 'PARSER_LIMIT' });
  await expect(parseDocument(Buffer.from('a'), 'x.txt', { limits: { depth: 65 } })).rejects.toMatchObject({ code: 'INVALID_PARSER_OPTIONS' });
});
it('ignores inert macros and rejects an encrypted CFB Office signature', async () => {
  const bytes = await editOffice('docx', (files) => { files['word/vbaProject.bin'] = Buffer.from('synthetic macro payload must never execute'); });
  const result = await parseDocument(bytes, 'macro.docx'); expect(result.warnings.some((w) => w.code === 'ACTIVE_CONTENT_IGNORED')).toBe(true);
  await expect(parseDocument(Buffer.from('d0cf11e0a1b11ae10000000000000000', 'hex'), 'encrypted.docx')).rejects.toMatchObject({ code: 'ENCRYPTED_DOCUMENT' });
});
it('terminates timed-out/cancelled workers and releases slots for later work', async () => {
  await expect(parseDocument(Buffer.from('a'.repeat(100000)), 'slow.md', { limits: { timeoutMs: 1 } })).rejects.toMatchObject({ code: 'PARSER_TIMEOUT' });
  const controller = new AbortController();
  const pending = parseDocument(Buffer.from('> '.repeat(10000)), 'cancel.md', { signal: controller.signal });
  const check = expect(pending).rejects.toMatchObject({ code: 'PARSER_CANCELLED' }); controller.abort(); await check;
  expect((await parseDocument(Buffer.from('after failure'), 'next.txt')).text).toBe('after failure');
});

it('bounds worker admission and permits cancellation while queued', async () => {
  const requests = Array.from({ length: 11 }, () => parseDocument(Buffer.from('queue fixture'), 'q.txt').then(() => 'ok', (e: unknown) => (e as { code: string }).code));
  const results = await Promise.all(requests); expect(results.filter((r) => r === 'ok')).toHaveLength(10); expect(results).toContain('PARSER_BUSY');
  const first = parseDocument(Buffer.from('first'), 'first.txt'); const second = parseDocument(Buffer.from('second'), 'second.txt');
  const controller = new AbortController(); const waiting = parseDocument(Buffer.from('queued'), 'queued.txt', { signal: controller.signal });
  const cancelled = expect(waiting).rejects.toMatchObject({ code: 'PARSER_CANCELLED' }); controller.abort(); await cancelled;
  await Promise.all([first, second]); expect((await parseDocument(Buffer.from('last'), 'last.txt')).text).toBe('last');
});
