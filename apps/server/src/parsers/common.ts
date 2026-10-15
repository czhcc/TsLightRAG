import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { DocumentFormatSchema, PARSER_LIMITS } from '@tslightrag/contracts';
import type { DocumentFormat, ParsedDocument, SourceLocation } from '@tslightrag/contracts';
export type Limits = { -readonly [K in keyof typeof PARSER_LIMITS]: number };
export class ParserError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function fail(code: string, message: string): never { throw new ParserError(code, message); }
export function limitsFor(input: Partial<Limits> = {}): Limits {
  for (const [key, value] of Object.entries(input)) {
    if (!(key in PARSER_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > PARSER_LIMITS[key as keyof Limits]) fail('INVALID_PARSER_OPTIONS', '解析预算只能收紧默认上限');
  }
  return { ...PARSER_LIMITS, ...input };
}
export function formatOf(name: string): DocumentFormat {
  if (!name || name.length > 255 || /[\\/\0]/.test(name)) fail('INVALID_FILE_NAME', '文件名不合法');
  const ext = extname(name).slice(1).toLowerCase();
  const format = DocumentFormatSchema.safeParse(ext === 'markdown' ? 'md' : ext === 'htm' ? 'html' : ext);
  if (!format.success) fail('UNSUPPORTED_FORMAT', '不支持此文档格式');
  return format.data;
}
export function utf8(bytes: Uint8Array) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('INVALID_ENCODING', '文本必须是有效 UTF-8'); }
  for (const char of text) if (char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char)) fail('INVALID_CONTENT', '文本包含二进制控制字符');
  return text.replace(/\r\n?/g, '\n');
}
export class Output {
  readonly blocks: ParsedDocument['blocks'] = [];
  readonly warnings: ParsedDocument['warnings'] = [];
  private warningKeys = new Set<string>();
  private parts: string[] = [];
  private size = 0;
  constructor(readonly limits: Limits) {}
  add(text: string, location: SourceLocation = {}, kind: ParsedDocument['blocks'][number]['kind'] = 'paragraph') {
    const clean = text.replace(/\r\n?/g, '\n').trim(); if (!clean) return;
    const start = this.size + (this.parts.length ? 2 : 0); const end = start + clean.length;
    if (end > this.limits.textChars || this.blocks.length >= this.limits.blocks) fail('PARSER_LIMIT', '文档文本或块数量超过解析上限');
    this.blocks.push({ kind, text: clean, location, start, end }); this.parts.push(clean); this.size = end;
  }
  warn(code: string, message: string, location?: SourceLocation) {
    const key = JSON.stringify([code, location]); if (this.warningKeys.has(key)) return;
    if (this.warnings.length >= 1000) fail('PARSER_LIMIT', '文档警告数量超过上限');
    this.warningKeys.add(key); this.warnings.push({ code, message, ...(location ? { location } : {}) });
  }
  finish(format: DocumentFormat, fileName: string, bytes: Uint8Array, extra: { pages?: number; sheets?: string[] } = {}): ParsedDocument {
    if (!this.parts.length) fail('EMPTY_DOCUMENT', '文档没有可提取文本');
    return { format, parserVersion: 's04-v1', text: this.parts.join('\n\n'), blocks: this.blocks,
      warnings: this.warnings, metadata: { fileName, contentHash: createHash('sha256').update(bytes).digest('hex'), ...extra } };
  }
}
