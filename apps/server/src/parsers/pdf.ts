import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ParserError } from './common.js';
import type { Output } from './common.js';

export async function parsePdf(bytes: Uint8Array, out: Output) {
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) fail('FORMAT_MISMATCH', 'PDF 文件头不匹配');
  // Load after the parser worker has disabled network entry points.
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdf.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const packageRoot = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
  const task = pdf.getDocument({ data: new Uint8Array(bytes), enableXfa: false, disableFontFace: true,
    useWorkerFetch: false, useSystemFonts: false, stopAtErrors: true, verbosity: 0,
    cMapUrl: `${join(packageRoot, 'cmaps')}/`, cMapPacked: true,
    standardFontDataUrl: `${join(packageRoot, 'standard_fonts')}/`, wasmUrl: `${join(packageRoot, 'wasm')}/`,
  });
  try {
    const document = await task.promise;
    if (document.numPages > out.limits.pages) fail('PARSER_LIMIT', 'PDF 页数超过上限');
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber); const content = await page.getTextContent();
      const text = content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
      if (!text) out.warn('PAGE_NO_TEXT', '此页没有文本层，不执行 OCR', { page: pageNumber });
      out.add(text, { page: pageNumber }); page.cleanup();
    }
    if (!out.blocks.length) fail('NEEDS_OCR', 'PDF 没有可提取文本层；扫描件需要 OCR，当前不支持');
    out.warn('PDF_READING_ORDER', '按页提取文本层，阅读顺序近似，不保证复杂排版或图片语义');
    return { pages: document.numPages };
  } catch (error) {
    if (error instanceof ParserError) throw error;
    if (error instanceof Error && error.name === 'PasswordException') fail('ENCRYPTED_DOCUMENT', '不支持加密 PDF');
    fail('INVALID_PDF', 'PDF 文本层读取失败');
  } finally { await task.destroy(); }
}
