import { posix } from 'node:path';
import { officeArchive } from './archive.js';
import { fail } from './common.js';
import type { Output } from './common.js';
import { xml, xmlText, runText, descendants, children } from './xml.js';
import type { XmlNode } from './xml.js';
import type { DocumentFormat } from '@tslightrag/contracts';

function required(files: Map<string, Uint8Array>, name: string) { const bytes = files.get(name); if (!bytes) fail('INVALID_OFFICE', 'Office 结构缺少必要部分'); return bytes; }
function part(files: Map<string, Uint8Array>, name: string, out: Output) { return xml(required(files, name), out.limits); }
function docx(files: Map<string, Uint8Array>, out: Output) {
  const root = part(files, 'word/document.xml', out); if (root.name !== 'document') fail('FORMAT_MISMATCH', 'DOCX 主文档类型不匹配');
  const body = children(root, 'body')[0]; if (!body) fail('INVALID_OFFICE', 'DOCX 缺少正文');
  let paragraph = 0; let table = 0; const heading: string[] = [];
  const visit = (node: XmlNode) => {
    if (node.name === 'p') {
      paragraph++; const text = runText(node);
      const style = descendants(node, 'pStyle')[0]?.attrs.val; const match = /^(?:Heading|标题)\s*([1-9])$/i.exec(style ?? '');
      if (match) { heading.length = Number(match[1]) - 1; heading.push(text); }
      out.add(text, { paragraph, headingPath: heading.filter(Boolean) }, match ? 'heading' : 'paragraph');
    } else if (node.name === 'tbl') {
      table++;
      children(node, 'tr').forEach((row, i) => {
        const cells = children(row, 'tc').map((cell) => children(cell, 'p').map(runText).join('\n'));
        if (cells.length > out.limits.columns || i >= out.limits.rows) fail('PARSER_LIMIT', 'DOCX 表格行列超过上限');
        out.add(cells.join('\t'), { table, row: i + 1, headingPath: heading.filter(Boolean) }, 'table');
      });
    } else for (const child of children(node)) visit(child);
  };
  for (const node of children(body)) visit(node);
  out.warn('OFFICE_SCOPE', '仅提取正文段落与表格；不含页眉页脚、图片、修订删除文本及嵌入对象语义');
}
function xlsx(files: Map<string, Uint8Array>, out: Output) {
  const root = part(files, 'xl/workbook.xml', out); if (root.name !== 'workbook') fail('FORMAT_MISMATCH', 'XLSX 工作簿类型不匹配');
  const rels = descendants(part(files, 'xl/_rels/workbook.xml.rels', out), 'Relationship');
  const shared = files.has('xl/sharedStrings.xml') ? descendants(part(files, 'xl/sharedStrings.xml', out), 'si').map(runText) : [];
  const sheets: string[] = [];
  for (const sheet of descendants(root, 'sheet')) {
    const name = sheet.attrs.name; if (!name || sheets.includes(name)) fail('INVALID_OFFICE', '工作表名称不合法或重复'); sheets.push(name);
    if (sheets.length > out.limits.pages) fail('PARSER_LIMIT', '工作表数量超过上限');
    const rel = rels.find((r) => r.attrs.Id === sheet.attrs['r:id']);
    if (!rel || rel.attrs.TargetMode === 'External' || !rel.attrs.Target) fail('INVALID_OFFICE', '工作表内部关系缺失');
    const target = rel.attrs.Target.startsWith('/') ? rel.attrs.Target.slice(1) : posix.normalize(posix.join('xl', rel.attrs.Target));
    if (!target.startsWith('xl/') || target.includes('..')) fail('UNSAFE_ARCHIVE', '工作表关系越界');
    const worksheet = part(files, target, out); if (worksheet.name !== 'worksheet') fail('INVALID_OFFICE', '工作表类型不匹配');
    let lastRow = 0; let rowCount = 0;
    for (const row of descendants(worksheet, 'row')) {
      const rowNumber = Number(row.attrs.r ?? lastRow + 1);
      if (!Number.isSafeInteger(rowNumber) || rowNumber <= lastRow || rowNumber > out.limits.rows || ++rowCount > out.limits.rows) fail('PARSER_LIMIT', '工作表行数或顺序不合法');
      lastRow = rowNumber; let lastColumn = 0;
      const cells: string[] = [];
      for (const cell of children(row, 'c')) {
        const reference = cell.attrs.r; const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(reference ?? '');
        if (!match || Number(match[2]) !== rowNumber) fail('INVALID_OFFICE', '单元格引用不合法');
        const column = [...match[1]!].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0);
        if (column <= lastColumn || column > out.limits.columns) fail('PARSER_LIMIT', '工作表列数或顺序超过上限'); lastColumn = column;
        const valueNode = children(cell, 'v')[0]; const formula = children(cell, 'f')[0]; let value = valueNode ? xmlText(valueNode) : '';
        if (formula && !valueNode) { value = `=${xmlText(formula)}`; out.warn('FORMULA_NO_CACHE', '公式没有缓存结果，保留公式文本但不计算', { sheet: name, row: rowNumber }); }
        else if (cell.attrs.t === 's') { const index = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || shared[index] === undefined) fail('INVALID_OFFICE', '共享字符串索引不合法'); value = shared[index]!; }
        else if (cell.attrs.t === 'inlineStr') value = children(cell, 'is').map(runText).join('');
        else if (cell.attrs.t === 'b') { if (!['0', '1'].includes(value)) fail('INVALID_OFFICE', '布尔单元格不合法'); value = value === '1' ? 'true' : 'false'; }
        else if (cell.attrs.t === 'e') out.warn('CELL_ERROR', '保留工作表缓存错误值', { sheet: name, row: rowNumber });
        else if ((!cell.attrs.t || cell.attrs.t === 'n') && value && !Number.isFinite(Number(value))) fail('INVALID_OFFICE', '数值单元格不合法');
        if (value) cells.push(`${reference}=${value}`);
      }
      out.add(cells.join('\t'), { sheet: name, row: rowNumber }, 'table');
    }
  }
  if (!sheets.length) fail('INVALID_OFFICE', '工作簿没有工作表');
  out.warn('XLSX_RAW_VALUES', '保留原始数值及公式缓存；不计算公式，不还原日期/数值显示样式'); return sheets;
}
function pptx(files: Map<string, Uint8Array>, out: Output) {
  const root = part(files, 'ppt/presentation.xml', out); if (root.name !== 'presentation') fail('FORMAT_MISMATCH', 'PPTX 主文档类型不匹配');
  const slides = [...files.keys()].map((path) => ({ path, number: /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/.exec(path)?.[1] }))
    .filter((s): s is { path: string; number: string } => Boolean(s.number)).sort((a, b) => Number(a.number) - Number(b.number));
  if (!slides.length) fail('INVALID_OFFICE', 'PPTX 没有幻灯片'); if (slides.length > out.limits.pages) fail('PARSER_LIMIT', '幻灯片数量超过上限');
  for (const slide of slides) {
    if (!Number.isSafeInteger(Number(slide.number))) fail('INVALID_OFFICE', '幻灯片编号不合法');
    const node = part(files, slide.path, out); if (node.name !== 'sld') fail('INVALID_OFFICE', '幻灯片结构不合法');
    let paragraph = 0; let table = 0;
    const visit = (n: XmlNode) => {
      if (n.name === 'tbl') {
        table++; children(n, 'tr').forEach((row, i) => {
          const cells = children(row, 'tc').map((c) => descendants(c, 'p').map(runText).join('\n'));
          if (i >= out.limits.rows || cells.length > out.limits.columns) fail('PARSER_LIMIT', '幻灯片表格超过上限');
          out.add(cells.join('\t'), { slide: Number(slide.number), table, row: i + 1 }, 'table');
        });
      } else if (n.name === 'p') { out.add(runText(n), { slide: Number(slide.number), paragraph: ++paragraph }); }
      else for (const child of children(n)) visit(child);
    };
    visit(node);
  }
  out.warn('PPTX_ORDER', '按 slide 数字编号及 XML 内顺序提取；不承诺视觉阅读顺序或母版/备注/图片语义');
  return slides.length;
}
export async function parseOffice(format: DocumentFormat, bytes: Uint8Array, out: Output) {
  const files = await officeArchive(bytes, out.limits);
  const expected = { docx: '/word/document.xml', xlsx: '/xl/workbook.xml', pptx: '/ppt/presentation.xml' }[format as 'docx' | 'xlsx' | 'pptx'];
  const type = descendants(part(files, '[Content_Types].xml', out), 'Override').find((n) => n.attrs.PartName === expected)?.attrs.ContentType;
  const types = { docx: 'wordprocessingml.document.main+xml', xlsx: 'spreadsheetml.sheet.main+xml', pptx: 'presentationml.presentation.main+xml' };
  if (!type?.endsWith(types[format as keyof typeof types])) fail('FORMAT_MISMATCH', 'Office 扩展名与内容类型不匹配');
  if ([...files.keys()].some((p) => /vbaProject|externalLinks|embeddings\//i.test(p))) out.warn('ACTIVE_CONTENT_IGNORED', '宏、外部数据连接和嵌入对象不执行');
  if ([...files.entries()].some(([name, data]) => name.endsWith('.rels') && descendants(xml(data, out.limits), 'Relationship').some((r) => r.attrs.TargetMode === 'External'))) out.warn('EXTERNAL_RESOURCES_IGNORED', 'Office 外部关系不会访问或下载');
  if (format === 'docx') { docx(files, out); return {}; }
  if (format === 'xlsx') return { sheets: xlsx(files, out) };
  return { pages: pptx(files, out) };
}
