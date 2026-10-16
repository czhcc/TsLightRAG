import { constants } from 'node:fs';
import { lstat, open, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ParsedDocumentSchema, SourceLocationSchema, IdSchema } from '@tslightrag/contracts';
import type { DocumentRecord, JobRecord } from '@tslightrag/contracts';
import { directory, syncDirectory } from '../storage/io.js';
import { ModelError } from '../models/errors.js';
import type { TextChunk } from '../core/chunker.js';
export const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
export class DocumentError extends ModelError {}
const ChunkSchema = z.strictObject({ id: IdSchema, docId: IdSchema, docVersion: z.number().int().positive(), order: z.number().int().nonnegative(),
  content: z.string().min(1), tokens: z.number().int().min(1).max(1200), start: z.number().int().nonnegative(), end: z.number().int().positive(),
  locations: z.array(z.strictObject({ blockIndex: z.number().int().nonnegative(), location: SourceLocationSchema })),
  chunkerVersion: z.literal('s04-window-v1'), tokenizer: z.enum(['js-tiktoken@1.0.21/cl100k_base', 'js-tiktoken@1.0.21/o200k_base']) });
export const ArtifactSchema = z.strictObject({ schemaVersion: z.literal(1), documentId: z.string(), docVersion: z.number().int().positive(),
  configRevision: z.number().int().nonnegative(), document: ParsedDocumentSchema, chunks: z.array(ChunkSchema).min(1).max(50_000) });
export type Artifact = Omit<z.infer<typeof ArtifactSchema>, 'chunks'> & { chunks: TextChunk[] };
export class DocumentFiles {
  constructor(private readonly root: string) {}
  async initialize() { for (const dir of ['documents', 'staging']) await directory(join(this.root, dir)); }
  private async read(path: string, cap: number) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > cap) throw new Error(); return await handle.readFile(); }
    finally { await handle.close(); }
  }
  private async publish(dir: string, name: string, bytes: Uint8Array) {
    await directory(dir); const temporary = join(dir, `.upload-${randomUUID()}.tmp`); const target = join(dir, name);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      try { await link(temporary, target); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        if ((await lstat(target)).isSymbolicLink() || digest(await this.read(target, bytes.length)) !== digest(bytes)) throw new Error('Existing blob differs', { cause: error });
      }
      await rm(temporary); await syncDirectory(dir);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async putSource(bytes: Uint8Array) {
    try { const hash = digest(bytes); await this.publish(join(this.root, 'documents'), `${hash}.blob`, bytes); return hash; }
    catch { throw new DocumentError('SOURCE_WRITE_FAILED', '原文件保存失败，未接受文档', 500); }
  }
  async source(doc: DocumentRecord) {
    try {
      await directory(join(this.root, 'documents'));
      if (!doc.ingestion || doc.ingestion.sourceKey !== `${doc.contentHash}.blob`) throw new Error();
      const bytes = await this.read(join(this.root, 'documents', doc.ingestion.sourceKey), 20 * 1024 * 1024);
      if (bytes.length !== doc.ingestion.bytes || digest(bytes) !== doc.contentHash) throw new Error(); return bytes;
    } catch { throw new DocumentError('SOURCE_INVALID', '原文件缺失、损坏或路径不安全', 409); }
  }
  async putArtifact(jobId: string, artifact: Artifact): Promise<NonNullable<JobRecord['result']>> {
    if (!/^j-[a-f0-9-]{36}$/.test(jobId)) throw new DocumentError('INVALID_JOB', '任务 ID 不合法', 400);
    const bytes = Buffer.from(JSON.stringify(artifact));
    if (bytes.length > 32 * 1024 * 1024) throw new DocumentError('ARTIFACT_LIMIT', '解析产物超过 32 MiB 上限', 413);
    try { await directory(join(this.root, 'staging')); await this.publish(join(this.root, 'staging', jobId), 'prepared.json', bytes); }
    catch { throw new DocumentError('ARTIFACT_WRITE_FAILED', '解析产物保存失败', 500); }
    return { artifactKey: `${jobId}/prepared.json`, sha256: digest(bytes), bytes: bytes.length,
      chunks: artifact.chunks.length, blocks: artifact.document.blocks.length, parserVersion: 's04-v1' };
  }
  async artifact(job: JobRecord, doc: Pick<DocumentRecord, 'id' | 'version' | 'contentHash'>) {
    try {
      const result = job.result;
      if (!result || result.artifactKey !== `${job.id}/prepared.json` || !/^j-[a-f0-9-]{36}$/.test(job.id)) throw new Error();
      await directory(join(this.root, 'staging'));
      await directory(join(this.root, 'staging', job.id));
      const bytes = await this.read(join(this.root, 'staging', job.id, 'prepared.json'), 32 * 1024 * 1024);
      if (bytes.length !== result.bytes || digest(bytes) !== result.sha256) throw new Error();
      const parsed = ArtifactSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (parsed.documentId !== doc.id || parsed.docVersion !== doc.version || parsed.document.metadata.contentHash !== doc.contentHash
        || parsed.chunks.length !== result.chunks || parsed.document.blocks.length !== result.blocks || parsed.configRevision !== job.configRevision) throw new Error();
      for (const [order, chunk] of parsed.chunks.entries()) if (chunk.docId !== doc.id || chunk.docVersion !== doc.version || chunk.order !== order
        || chunk.end > parsed.document.text.length || chunk.content !== parsed.document.text.slice(chunk.start, chunk.end)
        || chunk.locations.some((l) => !parsed.document.blocks[l.blockIndex])) throw new Error();
      return parsed;
    } catch { throw new DocumentError('ARTIFACT_INVALID', '解析产物缺失、损坏或路径不安全', 409); }
  }
}
