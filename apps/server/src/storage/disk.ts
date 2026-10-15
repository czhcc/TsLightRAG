import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lstat, readdir, rename } from 'node:fs/promises';
import { z } from 'zod';
import { FILE_NAMES, WorkspaceDraft } from './state.js';
import type { Files } from './state.js';
import { directory, readRegular, syncDirectory, writeNew } from './io.js';

export const GenerationSchema = z.string().regex(/^g-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const PointerSchema = z.strictObject({ schemaVersion: z.literal(1), generation: GenerationSchema, manifestHash: checksum });
const hashes = z.strictObject({
  'kv.json': checksum, 'document-status.json': checksum, 'vectors-chunks.json': checksum,
  'vectors-entities.json': checksum, 'vectors-relations.json': checksum, 'graph.json': checksum,
});
export const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), workspace: z.literal('default'), generation: GenerationSchema,
  previous: PointerSchema.nullable(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  corpusRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), files: hashes,
}).refine((value) => value.corpusRevision <= value.revision, 'Invalid corpus revision');
export type Pointer = z.infer<typeof PointerSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export function sha(contents: string) { return createHash('sha256').update(contents).digest('hex'); }
export type StoragePaths = { root: string; workspace: string; generations: string };

export async function loadGeneration(paths: StoragePaths, generation: string, expectedHash?: string) {
  GenerationSchema.parse(generation);
  const dir = join(paths.generations, generation);
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid generation directory');
  const contents = await readRegular(join(dir, 'manifest.json'));
  const hash = sha(contents);
  if (expectedHash !== undefined && hash !== expectedHash) throw new Error('Manifest checksum mismatch');
  const manifest = ManifestSchema.parse(JSON.parse(contents));
  if (manifest.generation !== generation || manifest.previous?.generation === generation) throw new Error('Generation identity mismatch');
  const files = {} as Files;
  for (const name of FILE_NAMES) {
    const contents = await readRegular(join(dir, name));
    if (sha(contents) !== manifest.files[name]) throw new Error(`Storage checksum mismatch: ${name}`);
    files[name] = JSON.parse(contents) as unknown;
  }
  return { state: WorkspaceDraft.restore(files), manifest, pointer: PointerSchema.parse({ schemaVersion: 1, generation, manifestHash: hash }) };
}

export async function loadCurrent(paths: StoragePaths) {
  const pointer = PointerSchema.parse(JSON.parse(await readRegular(join(paths.workspace, 'CURRENT'))));
  return loadGeneration(paths, pointer.generation, pointer.manifestHash);
}
export async function hasCurrent(paths: StoragePaths) {
  try { await lstat(join(paths.workspace, 'CURRENT')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function assertFresh(paths: StoragePaths) {
  // Missing CURRENT in an otherwise populated workspace is corruption, not an empty DB.
  if ((await readdir(paths.root)).some((name) => !['locks', 'workspace', 'config'].includes(name))
    || (await readdir(paths.generations)).length || (await readdir(paths.workspace)).some((name) => name !== 'generations')) {
    throw new Error('CURRENT missing from nonempty storage; explicit recovery required');
  }
}
export async function publishPointer(paths: StoragePaths, pointer: Pointer) {
  const temporary = join(paths.workspace, `.CURRENT-${randomUUID()}.tmp`);
  await writeNew(temporary, JSON.stringify(PointerSchema.parse(pointer)));
  await rename(temporary, join(paths.workspace, 'CURRENT'));
  try { await syncDirectory(paths.workspace); }
  catch (cause) {
    throw Object.assign(new Error('Recovery pointer was published; durability uncertain. Inspect before retrying.', { cause }), {
      published: true, generation: pointer.generation, durabilityConfirmed: false,
    });
  }
}
export async function writeGeneration(paths: StoragePaths, state: WorkspaceDraft, manifest: Manifest, hook?: (point: CommitPoint, file?: string) => Promise<void>) {
  const dir = join(paths.generations, manifest.generation); await directory(dir);
  const files = state.serialize();
  for (const name of FILE_NAMES) {
    const contents = JSON.stringify(files[name]);
    manifest.files[name] = sha(contents);
    await writeNew(join(dir, name), contents);
    await hook?.('after-namespace', name);
  }
  const contents = JSON.stringify(ManifestSchema.parse(manifest));
  await writeNew(join(dir, 'manifest.json'), contents);
  await syncDirectory(dir); await syncDirectory(paths.generations);
  await hook?.('after-manifest');
  return PointerSchema.parse({ schemaVersion: 1, generation: manifest.generation, manifestHash: sha(contents) });
}
export type CommitPoint = 'after-namespace' | 'after-manifest' | 'before-current' | 'after-current' | 'after-current-sync';
