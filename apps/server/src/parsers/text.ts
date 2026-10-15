import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { parse as htmlParse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { parse as csvParse } from 'csv-parse/sync';
import { fail, utf8 } from './common.js';
import type { Output } from './common.js';
import type { DocumentFormat } from '@tslightrag/contracts';

type MdNode = { type: string; value?: string; alt?: string; depth?: number; children?: MdNode[]; position?: { start: { line: number }; end: { line: number } } };
function mdText(n: MdNode): string {
  if (n.type === 'html') return ''; if (n.type === 'image') return n.alt ?? '';
  return n.value ?? (n.children ?? []).map(mdText).join(['list', 'listItem'].includes(n.type) ? '\n' : '');
}
function plain(text: string, out: Output) {
  const lines = text.split('\n'); let start = 0;
  for (let i = 0; i <= lines.length; i++) if (i === lines.length || !lines[i]?.trim()) {
    out.add(lines.slice(start, i).join('\n'), { lineStart: start + 1, lineEnd: Math.max(start + 1, i) }); start = i + 1;
  }
}
function markdown(text: string, out: Output) {
  const root = unified().use(remarkParse).parse(text) as MdNode;
  const heading: string[] = []; let nodes = 0;
  const check = (node: MdNode, depth: number) => {
    if (++nodes > out.limits.nodes || depth > out.limits.depth) fail('PARSER_LIMIT', 'Markdown 结构超过上限');
    for (const child of node.children ?? []) check(child, depth + 1);
  };
  check(root, 0); nodes = 0;
  const visit = (node: MdNode, depth: number) => {
    if (++nodes > out.limits.nodes || depth > out.limits.depth) fail('PARSER_LIMIT', 'Markdown 结构超过上限');
    if (node.type === 'heading') { heading.length = Math.max(0, (node.depth ?? 1) - 1); heading[(node.depth ?? 1) - 1] = mdText(node); }
    if (['heading', 'paragraph', 'code', 'list'].includes(node.type)) {
      out.add(mdText(node), { ...(node.position ? { lineStart: node.position.start.line, lineEnd: node.position.end.line } : {}), headingPath: heading.filter(Boolean) }, node.type === 'code' ? 'code' : node.type === 'heading' ? 'heading' : node.type === 'list' ? 'list' : 'paragraph');
    } else if (node.type === 'html') out.warn('MARKDOWN_HTML_OMITTED', 'Markdown 内嵌 HTML 未执行且未作为正文提取');
    else for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
}
type HtmlNode = DefaultTreeAdapterMap['node'];
function html(text: string, out: Output) {
  const root = htmlParse(text); let nodes = 0; const heading: string[] = [];
  const skipped = new Set(['script', 'style', 'noscript', 'template', 'head', 'iframe', 'object', 'embed', 'svg']);
  const textOf = (n: HtmlNode, depth: number): string => {
    if (++nodes > out.limits.nodes || depth > out.limits.depth) fail('PARSER_LIMIT', 'HTML 结构超过上限');
    if ('tagName' in n && skipped.has(n.tagName)) return '';
    if (n.nodeName === '#text' && 'value' in n) return n.value;
    if ('tagName' in n && n.tagName === 'br') return '\n';
    return 'childNodes' in n ? n.childNodes.map((c) => textOf(c, depth + 1)).join('') : '';
  };
  const visit = (n: HtmlNode, depth: number) => {
    if (++nodes > out.limits.nodes || depth > out.limits.depth) fail('PARSER_LIMIT', 'HTML 结构超过上限');
    if ('tagName' in n && skipped.has(n.tagName)) return;
    const name = 'tagName' in n ? n.tagName : '';
    if (/^h[1-6]$/.test(name)) {
      const value = textOf(n, depth).replace(/\s+/g, ' ').trim(); heading.length = Number(name[1]) - 1; heading.push(value);
      out.add(value, { headingPath: heading.filter(Boolean) }, 'heading'); return;
    }
    if (['p', 'li', 'pre', 'tr'].includes(name)) {
      const value = name === 'tr' && 'childNodes' in n ? n.childNodes.filter((c) => 'tagName' in c && ['td', 'th'].includes(c.tagName)).map((c) => textOf(c, depth + 1).trim()).join('\t') : textOf(n, depth);
      out.add(value.replace(/[ \t]+/g, name === 'tr' ? '\t' : ' '), { headingPath: heading.filter(Boolean) }, name === 'tr' ? 'table' : name === 'li' ? 'list' : name === 'pre' ? 'code' : 'paragraph'); return;
    }
    if (n.nodeName === '#text' && 'value' in n) { out.add(n.value, { headingPath: heading.filter(Boolean) }); return; }
    if ('childNodes' in n) for (const child of n.childNodes) visit(child, depth + 1);
  };
  visit(root, 0);
}
function json(text: string, out: Output) {
  // Bound syntax nesting before JSON.parse allocates a deep object graph.
  let depth = 0; let quoted = false; let escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > out.limits.depth) fail('PARSER_LIMIT', 'JSON 嵌套超过上限'); }
    else if (char === '}' || char === ']') depth--;
  }
  let value: unknown; try { value = JSON.parse(text) as unknown; } catch { fail('INVALID_JSON', 'JSON 文档格式不合法'); }
  let nodes = 0;
  const visit = (item: unknown, path: string) => {
    if (++nodes > out.limits.nodes) fail('PARSER_LIMIT', 'JSON 节点数超过上限');
    if (item !== null && typeof item === 'object') {
      if (!Object.keys(item).length) return;
      for (const key of (Array.isArray(item) ? Object.keys(item) : Object.keys(item).sort())) visit((item as Record<string, unknown>)[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    } else {
      if (typeof item === 'number' && !Number.isFinite(item)) fail('INVALID_JSON', 'JSON 数值必须有限');
      out.add(`${path || '/'}: ${JSON.stringify(item)}`, { jsonPointer: path }, 'value');
    }
  };
  visit(value, '');
}
export function parseText(format: DocumentFormat, bytes: Uint8Array, out: Output) {
  const text = utf8(bytes);
  if (text.length > out.limits.textChars) fail('PARSER_LIMIT', '输入文本超过字符上限');
  if (format === 'txt') plain(text, out);
  else if (format === 'md') markdown(text, out);
  else if (format === 'html') html(text, out);
  else if (format === 'json') json(text, out);
  else if (format === 'csv') {
    let records: { record: string[]; info: { lines: number } }[];
    try { records = csvParse(text, { bom: true, skip_empty_lines: true, info: true, max_record_size: out.limits.textChars,
      on_record: (record: string[]) => {
        const info = record as unknown as { record: string[]; info: { records: number } };
        if (info.record.length > out.limits.columns || info.info.records > out.limits.rows) fail('PARSER_LIMIT', 'CSV 行列超过上限'); return record;
      },
    }) as unknown as typeof records; } catch (e) { if (e instanceof Error && 'code' in e && e.code === 'PARSER_LIMIT') throw e; fail('INVALID_CSV', 'CSV 文档格式不合法或行长度超限'); }
    records.forEach((record, i) => { out.add(record.record.join('\t'), { row: i + 1, lineEnd: record.info.lines }, 'table'); });
  } else fail('UNSUPPORTED_FORMAT', '此入口不支持二进制格式');
}
