import { createHash } from 'node:crypto';
import { IdSchema, ParsedDocumentSchema } from '@tslightrag/contracts';
import type { ParsedDocument, SourceLocation } from '@tslightrag/contracts';
import { tokenizer, TOKENIZER_VERSION } from './tokenizer.js';
import type { Encoding } from './tokenizer.js';
import { fail } from '../parsers/common.js';
export interface ChunkOptions { docId: string; docVersion: number; windowTokens?: number; overlapTokens?: number; encoding?: Encoding }
export interface TextChunk {
  id: string; docId: string; docVersion: number; order: number; content: string; tokens: number;
  start: number; end: number; locations: { blockIndex: number; location: SourceLocation }[];
  chunkerVersion: string; tokenizer: string;
}
export function chunkDocument(input: ParsedDocument, options: ChunkOptions): TextChunk[] {
  const parsed = ParsedDocumentSchema.safeParse(input); if (!parsed.success) fail('INVALID_CHUNK_INPUT', '解析结果不合法');
  const document = parsed.data;
  const { docId, docVersion, windowTokens = 1200, overlapTokens = 100, encoding = 'cl100k_base' } = options;
  if (!IdSchema.safeParse(docId).success || !Number.isSafeInteger(docVersion) || docVersion < 1
      || !Number.isSafeInteger(windowTokens) || windowTokens < 1 || windowTokens > 16_384
      || !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= windowTokens) fail('INVALID_CHUNK_OPTIONS', '分块窗口或重叠参数不合法');
  if (!document.text.trim()) fail('EMPTY_DOCUMENT', '无法分块空文档');
  const encoder = tokenizer(encoding); const chunks: TextChunk[] = []; let start = 0;
  for (const block of document.blocks) if (block.end <= block.start || document.text.slice(block.start, block.end) !== block.text) fail('INVALID_CHUNK_INPUT', '解析块偏移不一致');
  while (start < document.text.length) {
    // The pinned encodings have at most 128 bytes per ordinary token. Bound
    // tokenization work per window; never decode a half UTF-8 character as U+FFFD.
    let candidateEnd = Math.min(document.text.length, start + windowTokens * 128);
    if (candidateEnd < document.text.length && /[\uDC00-\uDFFF]/u.test(document.text[candidateEnd]!)) candidateEnd--;
    const tokens = encoder.encode(document.text.slice(start, candidateEnd));
    let endToken = Math.min(windowTokens, tokens.length); let content = '';
    while (endToken > 0) {
      content = encoder.decode(tokens.slice(0, endToken));
      if (content && document.text.startsWith(content, start) && encoder.encode(content).length <= windowTokens) break;
      endToken--;
    }
    if (!endToken || !content) fail('CHUNK_WINDOW_TOO_SMALL', 'token 窗口不足以容纳一个完整 Unicode 字符');
    const end = start + content.length; const actualTokens = encoder.encode(content);
    const identity = JSON.stringify([docId, docVersion, document.metadata.contentHash, 's04-window-v1', TOKENIZER_VERSION, encoding, windowTokens, overlapTokens, start, end, content]);
    chunks.push({ id: createHash('sha256').update(identity).digest('hex'), docId, docVersion,
      order: chunks.length, content, tokens: actualTokens.length, start, end,
      locations: document.blocks.flatMap((block, blockIndex) => block.start < end && block.end > start ? [{ blockIndex, location: structuredClone(block.location) }] : []),
      chunkerVersion: 's04-window-v1', tokenizer: `${TOKENIZER_VERSION}/${encoding}` });
    if (chunks.length > 50_000) fail('PARSER_LIMIT', '分块数量超过上限');
    if (end === document.text.length) break;
    let overlap = Math.min(overlapTokens, actualTokens.length - 1); let suffix = '';
    while (overlap > 0) {
      suffix = encoder.decode(actualTokens.slice(-overlap));
      if (suffix && content.endsWith(suffix) && encoder.encode(suffix).length <= overlapTokens) break;
      overlap--;
    }
    const next = overlap ? end - suffix.length : end;
    if (next <= start) fail('INVALID_CHUNK_OPTIONS', '分块未取得进展'); start = next;
  }
  return chunks;
}
