// Original deterministic synthetic files. No Python, downloads or external assets.
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
const root = new URL('./documents/', import.meta.url); await mkdir(root, { recursive: true });
const save = (name, bytes) => writeFile(new URL(name, root), bytes);
const ns = { w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' };
const relns = 'http://schemas.openxmlformats.org/package/2006/relationships';
const types = { docx: ['word/document.xml', 'wordprocessingml.document.main+xml'], xlsx: ['xl/workbook.xml', 'spreadsheetml.sheet.main+xml'], pptx: ['ppt/presentation.xml', 'presentationml.presentation.main+xml'] };
function archive(kind, files) {
  const [main, type] = types[kind];
  const all = { '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="${ns.r}/officeDocument" Target="${main}"/></Relationships>`, ...files };
  return zipSync(Object.fromEntries(Object.entries(all).map(([key, value]) => [key, strToU8(value)])), { level: 6, mtime: new Date('2020-01-01T00:00:00Z') });
}
await save('sample.txt', '\ufeff中文知识\r\nemoji 🧮\r\n\r\n第二段\r\n');
await save('sample.md', '# 知识图谱\n\n中文 **证据** 和 [链接](http://127.0.0.1:9/never).\n\n## 数据\n\n- 第一项\n- 🧮 第二项\n\n```ts\nconst n = 1;\n```\n');
await save('sample.html', '<!doctype html><html><head><title>不作为正文</title><script>throw new Error("never")</script></head><body><h1>知识图谱</h1><p>中文 <b>证据</b> 🧮</p><ul><li>第一项</li></ul><table><tr><td>名称</td><td>值</td></tr><tr><td>甲</td><td>1</td></tr></table><img src="http://127.0.0.1:9/image"><iframe src="http://127.0.0.1:9/frame"></iframe></body></html>');
await save('sample.csv', '名称,备注\r\n甲,"中文, 🧮"\r\n乙,"多行\n文本"\r\n');
await save('sample.json', JSON.stringify({ '中文': '知识 🧮', 'a/b': { '~key': true }, z: [1, 2] }, null, 2));
const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const doc = (body) => `<w:document xmlns:w="${ns.w}"><w:body>${body}</w:body></w:document>`;
await save('sample.docx', archive('docx', { 'word/document.xml': doc('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>知识图谱</w:t></w:r></w:p>' + paragraph('表前中文 🧮') + `<w:tbl><w:tr><w:tc>${paragraph('名称')}</w:tc><w:tc>${paragraph('值')}</w:tc></w:tr><w:tr><w:tc>${paragraph('实体')}</w:tc><w:tc>${paragraph('关系')}</w:tc></w:tr></w:tbl>` + paragraph('表后证据')),
 'word/_rels/document.xml.rels': `<Relationships xmlns="${relns}"><Relationship Id="external" Type="${ns.r}/hyperlink" Target="http://127.0.0.1:9/office" TargetMode="External"/></Relationships>` }));
await save('empty.docx', archive('docx', { 'word/document.xml': doc('<w:p/>') }));
const workbook = `<workbook xmlns="${ns.s}" xmlns:r="${ns.r}"><sheets><sheet name="知识" sheetId="1" r:id="s1"/><sheet name="第二表" sheetId="2" r:id="s2"/></sheets></workbook>`;
const sheetRels = `<Relationships xmlns="${relns}"><Relationship Id="s1" Type="${ns.r}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Type="${ns.r}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
const worksheet = (rows) => `<worksheet xmlns="${ns.s}"><sheetData>${rows}</sheetData></worksheet>`;
const xlsxBase = { 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': sheetRels,
 'xl/sharedStrings.xml': `<sst xmlns="${ns.s}"><si><t>中文 🧮</t></si></sst>` };
await save('sample.xlsx', archive('xlsx', { ...xlsxBase,
 'xl/worksheets/sheet1.xml': worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><f>SUM(B1,3)</f><v>5</v></c><c r="B2"><f>SUM(1,2)</f></c></row>'),
 'xl/worksheets/sheet2.xml': worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>第二表证据</t></is></c><c r="B1" t="b"><v>1</v></c></row>') }));
await save('empty.xlsx', archive('xlsx', { ...xlsxBase, 'xl/worksheets/sheet1.xml': worksheet(''), 'xl/worksheets/sheet2.xml': worksheet('') }));
const slide = (inside) => `<p:sld xmlns:p="${ns.p}" xmlns:a="${ns.a}"><p:cSld><p:spTree>${inside}</p:spTree></p:cSld></p:sld>`;
const shape = (text) => `<p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const presentation = `<p:presentation xmlns:p="${ns.p}" xmlns:r="${ns.r}"><p:sldIdLst><p:sldId id="256" r:id="s10"/><p:sldId id="257" r:id="s2"/></p:sldIdLst></p:presentation>`;
await save('sample.pptx', archive('pptx', { 'ppt/presentation.xml': presentation,
 'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${relns}"><Relationship Id="s10" Type="${ns.r}/slide" Target="slides/slide10.xml"/><Relationship Id="s2" Type="${ns.r}/slide" Target="slides/slide2.xml"/></Relationships>`,
 'ppt/slides/slide10.xml': slide(shape('第十张')),
 'ppt/slides/slide2.xml': slide(`<p:grpSp>${shape('第二张 中文 🧮')}</p:grpSp><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>表格证据</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`) }));
await save('empty.pptx', archive('pptx', { 'ppt/presentation.xml': presentation, 'ppt/slides/slide1.xml': slide('') }));
// Minimal valid PDFs with explicit xref byte offsets, text layer and deterministic CMap.
function pdf(objects, trailer = '') {
 let body = '%PDF-1.7\n'; const offsets = [0];
 objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body, 'binary')); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
 const xref = Buffer.byteLength(body, 'binary'); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
 for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
 body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body, 'binary');
}
const stream = (text, dict = '') => `<< /Length ${Buffer.byteLength(text, 'binary')} ${dict} >>\nstream\n${text}\nendstream`;
const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /SyntheticUnicode def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <4E2D> <0002> <6587> <0003> <D83EDDEE> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
await save('sample.pdf', pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F2 7 0 R >> >> /Contents 8 0 R >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream('BT /F1 12 Tf 30 100 Td (Local graph evidence) Tj ET'),
 '<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticCJK /Encoding /Identity-H /DescendantFonts [9 0 R] /ToUnicode 10 0 R >>',
 stream('BT /F2 12 Tf 30 100 Td <000100020003> Tj ET'),
 '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>', stream(cmap)]));
const blank = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>', stream('')];
await save('empty.pdf', pdf(blank));
const image = deflateSync(Buffer.from([255, 0, 0])).toString('binary');
await save('scanned.pdf', pdf([blank[0], blank[1], '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>', stream('q 100 0 0 100 0 0 cm /Im0 Do Q'), stream(image, '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode')]));
const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const pad = (s) => Buffer.concat([Buffer.from(s), padding]).subarray(0, 32);
const md5 = (s) => createHash('md5').update(s).digest();
function rc4(key, input) { const box = Array.from({ length: 256 }, (_, i) => i); let j = 0; for (let i = 0; i < 256; i++) { j = (j + box[i] + key[i % key.length]) % 256; [box[i], box[j]] = [box[j], box[i]]; } let i = 0; j = 0; return Buffer.from(input.map((value) => { i = (i + 1) % 256; j = (j + box[i]) % 256; [box[i], box[j]] = [box[j], box[i]]; return value ^ box[(box[i] + box[j]) % 256]; })); }
const owner = rc4(md5(pad('owner')).subarray(0, 5), pad('password')); const id = Buffer.alloc(16, 1); const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
const key = md5(Buffer.concat([pad('password'), owner, permissions, id])).subarray(0, 5); const user = rc4(key, padding);
await save('encrypted.pdf', pdf([...blank, `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`], `/Encrypt 5 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]`));
await save('invalid-utf8.txt', Buffer.from([0xc3, 0x28]));
await save('broken.pdf', '%PDF-1.7\nnot-a-document');
await save('broken.docx', 'not-a-zip');
console.log('Generated deterministic local document fixtures');
