import yauzl from 'yauzl';
import type { Readable } from 'node:stream';
import type { Entry, ZipFile } from 'yauzl';
import { crc32 } from 'node:zlib';
import { fail, ParserError } from './common.js';
import type { Limits } from './common.js';
import { xml, descendants } from './xml.js';

export async function officeArchive(bytes: Uint8Array, limits: Limits) {
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) fail('ENCRYPTED_DOCUMENT', '不支持加密 Office 或旧二进制 Office 容器');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('FORMAT_MISMATCH', 'Office 文件必须是有效 OOXML ZIP 容器');
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, file) => {
      if (error || !file) reject(new ParserError('INVALID_ARCHIVE', 'Office ZIP 无法读取')); else resolve(file);
    });
  });
  try {
    if (zip.entryCount > limits.zipEntries) fail('PARSER_LIMIT', 'ZIP 项数超过上限');
    const entries = await new Promise<Entry[]>((resolve, reject) => {
      const all: Entry[] = []; const names = new Set<string>(); let total = 0;
      zip.on('error', () => { reject(new ParserError('INVALID_ARCHIVE', 'Office ZIP 损坏')); });
      zip.on('end', () => { resolve(all); });
      zip.on('entry', (entry: Entry) => {
        try {
          const path = entry.fileName;
          if (!path || /[\\\0]/.test(path) || path.startsWith('/') || /^[a-z]:/i.test(path)
              || path.split('/').some((s) => s === '..' || s === '.') || names.has(path)
              || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) fail('UNSAFE_ARCHIVE', 'ZIP 路径或文件类型不安全');
          if (path.split('/').length > limits.depth) fail('PARSER_LIMIT', 'ZIP 路径过深');
          names.add(path); total += entry.uncompressedSize;
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > limits.zipEntryBytes || total > limits.zipBytes || all.length >= limits.zipEntries) fail('PARSER_LIMIT', 'ZIP 解压大小超过上限');
          if (entry.generalPurposeBitFlag & 1) fail('ENCRYPTED_DOCUMENT', '不支持加密 Office ZIP');
          if (![0, 8].includes(entry.compressionMethod)) fail('INVALID_ARCHIVE', '不支持此 ZIP 压缩方法');
          all.push(entry); zip.readEntry();
        } catch (e) { reject(e); }
      });
      zip.readEntry();
    });
    const files = new Map<string, Uint8Array>(); let expanded = 0;
    for (const entry of entries) {
      if (entry.fileName.endsWith('/')) continue;
      const stream = await new Promise<Readable>((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => { if (error || !stream) reject(new ParserError('INVALID_ARCHIVE', 'ZIP 项无法解压')); else resolve(stream); });
      });
      const chunks: Buffer[] = []; let count = 0; let crc = 0;
      try {
        for await (const raw of stream) {
          const chunk = Buffer.from(raw as Uint8Array); count += chunk.length; expanded += chunk.length;
          if (count > limits.zipEntryBytes || expanded > limits.zipBytes) { stream.destroy(); fail('PARSER_LIMIT', 'ZIP 实际解压大小超过上限'); }
          crc = crc32(chunk, crc); chunks.push(chunk);
        }
      } catch (e) { if (e instanceof ParserError) throw e; fail('INVALID_ARCHIVE', 'ZIP 解压数据损坏'); }
      if (count !== entry.uncompressedSize || crc !== entry.crc32) fail('INVALID_ARCHIVE', 'ZIP 大小或 CRC 校验失败');
      files.set(entry.fileName, Buffer.concat(chunks));
    }
    if (!files.has('[Content_Types].xml') || !files.has('_rels/.rels')) fail('FORMAT_MISMATCH', '缺少 OOXML 内容类型或包关系');
    // Validate every XML/relationship before any format parser sees it.
    for (const [name, data] of files) if (/\.(?:xml|rels)$/i.test(name)) {
      const root = xml(data, limits);
      if (name.endsWith('.rels') && root.name !== 'Relationships') fail('INVALID_XML', 'Office 关系根节点不合法');
      for (const rel of name.endsWith('.rels') ? descendants(root, 'Relationship') : []) {
        if (rel.attrs.TargetMode === 'External') continue; // Never resolved/downloaded.
        if (/^[a-z]+:/i.test(rel.attrs.Target ?? '')) fail('UNSAFE_ARCHIVE', 'Office 内部关系不能指向 URL');
      }
    }
    return files;
  } finally { zip.close(); }
}
