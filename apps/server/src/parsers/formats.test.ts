import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseDocument } from './index.js';
import { documentFixture, editOffice, xmlBytes } from '../../../../tests/helpers/document-fixtures.js';
const golden = JSON.parse(await readFile(new URL('../../../../tests/fixtures/documents/expected.json', import.meta.url), 'utf8')) as Record<string, { text: string; locations: unknown[] }>;
it.each(['txt', 'md', 'html', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'pptx'])('parses real %s fixture and exact content/location golden in a worker', async (format) => {
  const bytes = await documentFixture(`sample.${format}`); const original = Buffer.from(bytes);
  const doc = await parseDocument(bytes, `sample.${format}`);
  expect(doc.text).toBe(golden[format]?.text); expect(doc.blocks.map((b) => b.location)).toEqual(golden[format]?.locations);
  expect(doc.metadata.contentHash).toBe(createHash('sha256').update(bytes).digest('hex')); expect(bytes).toEqual(original);
  for (const b of doc.blocks) expect(doc.text.slice(b.start, b.end)).toBe(b.text);
});
it.each(['txt', 'md', 'html', 'csv', 'json'])('refuses empty %s without empty success', async (ext) => {
  const body = ext === 'json' ? '{}' : ext === 'html' ? '<script>private();</script><style>a{}</style>' : '  \n\n';
  await expect(parseDocument(Buffer.from(body), `empty.${ext}`)).rejects.toMatchObject({ code: 'EMPTY_DOCUMENT' });
});
it.each(['docx', 'xlsx', 'pptx'])('refuses real empty Office %s', async (ext) => {
  await expect(parseDocument(await documentFixture(`empty.${ext}`), `empty.${ext}`)).rejects.toMatchObject({ code: 'EMPTY_DOCUMENT' });
});
it.each(['empty.pdf', 'scanned.pdf'])('explicitly requires OCR for %s', async (name) => {
  await expect(parseDocument(await documentFixture(name), name)).rejects.toMatchObject({ code: 'NEEDS_OCR' });
});
it('rejects encrypted PDF and corrupt PDF/Office with safe errors', async () => {
  for (const [name, code] of [['encrypted.pdf', 'ENCRYPTED_DOCUMENT'], ['broken.pdf', 'INVALID_PDF'], ['broken.docx', 'FORMAT_MISMATCH']]) {
    await expect(parseDocument(await documentFixture(name!), name!)).rejects.toMatchObject({ code });
  }
});
it('rejects invalid UTF-8, binary text, malformed JSON/CSV and unsupported extensions', async () => {
  await expect(parseDocument(await documentFixture('invalid-utf8.txt'), 'bad.txt')).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
  for (const [name, text, code] of [['bad.txt', '\0hidden', 'INVALID_CONTENT'], ['bad.json', '{bad-private', 'INVALID_JSON'], ['bad.json', '1e999', 'INVALID_JSON'], ['bad.csv', 'a,b\n"unclosed', 'INVALID_CSV'], ['not.doc', 'x', 'UNSUPPORTED_FORMAT']]) {
    await expect(parseDocument(Buffer.from(text!), name!)).rejects.toMatchObject({ code });
  }
});
it('checks extension/content rather than accepting arbitrary ZIP/PDF bytes', async () => {
  await expect(parseDocument(await documentFixture('sample.docx'), 'fake.xlsx')).rejects.toMatchObject({ code: 'FORMAT_MISMATCH' });
  await expect(parseDocument(Buffer.from('not pdf'), 'fake.pdf')).rejects.toMatchObject({ code: 'FORMAT_MISMATCH' });
  await expect(parseDocument(Buffer.from('a'), '../secret.txt')).rejects.toMatchObject({ code: 'INVALID_FILE_NAME' });
});
it('preserves DOCX sequence, cached/uncached XLSX formulas and numeric/grouped PPTX content', async () => {
  const docx = await parseDocument(await documentFixture('sample.docx'), 'sample.docx');
  expect(docx.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'table', 'table', 'paragraph']);
  const xlsx = await parseDocument(await documentFixture('sample.xlsx'), 'sample.xlsx');
  expect(xlsx.metadata.sheets).toEqual(['知识', '第二表']); expect(xlsx.warnings).toContainEqual({ code: 'FORMULA_NO_CACHE', message: '公式没有缓存结果，保留公式文本但不计算', location: { sheet: '知识', row: 2 } });
  const pptx = await parseDocument(await documentFixture('sample.pptx'), 'sample.pptx'); expect(pptx.blocks.map((b) => b.location.slide)).toEqual([2, 2, 10]);
});
it('does not evaluate formula-like CSV or JSON strings and omits Markdown HTML', async () => {
  const csv = await parseDocument(Buffer.from('=1+1,+1\n'), 'formula.csv'); expect(csv.text).toContain('=1+1');
  const json = await parseDocument(Buffer.from('{"__proto__":"literal","code":"fetch(1)"}'), 'literal.json'); expect(json.text).toContain('fetch(1)');
  const md = await parseDocument(Buffer.from('文字\n\n<script>private()</script>'), 'literal.md'); expect(md.text).toBe('文字'); expect(md.warnings[0]?.code).toBe('MARKDOWN_HTML_OMITTED');
});
it('fails on missing workbook relations, illegal shared strings or corrupt XML', async () => {
  const fixtures = [await editOffice('xlsx', (f) => { delete f['xl/_rels/workbook.xml.rels']; }), await editOffice('xlsx', (f) => { f['xl/sharedStrings.xml'] = xmlBytes('<sst/>'); }), await editOffice('docx', (f) => { f['word/document.xml'] = xmlBytes('<document><broken></document>'); })];
  for (const [i, fixture] of fixtures.entries()) await expect(parseDocument(fixture, i === 2 ? 'bad.docx' : 'bad.xlsx')).rejects.toBeInstanceOf(Error);
});

it.each(['txt', 'md', 'html', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'pptx'])('rejects corrupt binary content for %s with a structured error', async (ext) => {
  const outcome = await parseDocument(Buffer.from([0xff, 0xfe, 0, 0]), `broken.${ext}`).catch((e: unknown) => e);
  expect(outcome).toBeInstanceOf(Error); expect(outcome).toHaveProperty('code');
});
it('preserves JSON array numeric order beyond ten elements', async () => {
  const doc = await parseDocument(Buffer.from(JSON.stringify(Array.from({ length: 12 }, (_, i) => i))), 'array.json');
  expect(doc.blocks.map((b) => b.location.jsonPointer)).toEqual(Array.from({ length: 12 }, (_, i) => `/${String(i)}`));
});
