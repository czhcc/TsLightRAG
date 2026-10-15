import { z } from 'zod';

export const DocumentFormatSchema = z.enum(['txt', 'md', 'html', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'pptx']);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;
export const SourceLocationSchema = z.strictObject({
  page: z.number().int().positive().optional(), paragraph: z.number().int().positive().optional(),
  lineStart: z.number().int().positive().optional(), lineEnd: z.number().int().positive().optional(),
  headingPath: z.array(z.string()).max(64).optional(), table: z.number().int().positive().optional(),
  sheet: z.string().optional(), row: z.number().int().positive().optional(), slide: z.number().int().positive().optional(),
  jsonPointer: z.string().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export const ParsedBlockSchema = z.strictObject({
  kind: z.enum(['paragraph', 'heading', 'list', 'table', 'code', 'value']), text: z.string().min(1),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), location: SourceLocationSchema,
});
export const ParserWarningSchema = z.strictObject({ code: z.string(), message: z.string(), location: SourceLocationSchema.optional() });
export const ParsedDocumentSchema = z.strictObject({
  format: DocumentFormatSchema, parserVersion: z.literal('s04-v1'), text: z.string().min(1),
  blocks: z.array(ParsedBlockSchema).min(1).max(50_000), warnings: z.array(ParserWarningSchema).max(1000),
  metadata: z.strictObject({ fileName: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    pages: z.number().int().positive().optional(), sheets: z.array(z.string()).optional() }),
}).superRefine((doc, ctx) => {
  let expectedStart = 0;
  for (const [index, block] of doc.blocks.entries()) {
    if (block.start !== expectedStart || block.end !== block.start + block.text.length || doc.text.slice(block.start, block.end) !== block.text) {
      ctx.addIssue({ code: 'custom', path: ['blocks', index], message: '正文块与规范化文本偏移不一致' });
    }
    expectedStart = block.end + 2;
  }
  if (doc.blocks.map((b) => b.text).join('\n\n') !== doc.text) ctx.addIssue({ code: 'custom', path: ['text'], message: '正文与块内容不一致' });
});
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;
export const PARSER_LIMITS = Object.freeze({
  inputBytes: 20 * 1024 * 1024, zipBytes: 100 * 1024 * 1024, zipEntries: 10_000,
  zipEntryBytes: 20 * 1024 * 1024, textChars: 2_000_000, blocks: 50_000,
  depth: 64, nodes: 200_000, rows: 50_000, columns: 512, pages: 500,
  timeoutMs: 60_000, workerHeapMb: 256,
});
export const PARSER_CAPABILITIES = Object.freeze({
  parserVersion: 's04-v1', localOnly: true,
  limits: PARSER_LIMITS,
  formats: [
    { format: 'txt', label: 'TXT', scope: '严格 UTF-8；段落和行号' },
    { format: 'md', label: 'Markdown', scope: '标题路径、段落、列表与代码；不下载链接和图片' },
    { format: 'html', label: 'HTML', scope: '静态正文、标题、列表与表格；不执行脚本和加载资源' },
    { format: 'csv', label: 'CSV', scope: 'UTF-8、引号字段、行列限制及记录位置' },
    { format: 'json', label: 'JSON', scope: '合法 JSON、稳定字段顺序、JSON Pointer 位置；限制深度' },
    { format: 'pdf', label: 'PDF', scope: '本地文本层和页码；近似阅读顺序，不含 OCR' },
    { format: 'docx', label: 'DOCX', scope: '段落、样式标题与表格的文档顺序；不含 smart heading' },
    { format: 'xlsx', label: 'XLSX', scope: '工作表、行列、共享字符串和公式缓存；不计算公式' },
    { format: 'pptx', label: 'PPTX', scope: '幻灯片文本、组形状和表格；按幻灯片编号排序' },
  ],
  exclusions: ['扫描件 OCR', '加密文档', '图片/音视频理解', '公式或宏执行', '逐像素版面还原', '远程解析或资源下载'],
});
