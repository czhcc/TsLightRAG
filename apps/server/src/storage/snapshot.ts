import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rename } from 'node:fs/promises';
import { WorkspaceDraft, FILE_NAMES } from './state.js';
import { StoredDocumentSchema } from './state.js';
import type { KVName } from './state.js';
import { layout, syncDirectory, writeNew } from './io.js';
import { WriterLock } from './writer-lock.js';
import { assertFresh, hasCurrent, loadCurrent, sha, writeGeneration } from './disk.js';
import type { CommitPoint, Manifest, Pointer, StoragePaths } from './disk.js';

type Current = { state: WorkspaceDraft; manifest: Manifest; pointer: Pointer };
function corpusIdentity(state: WorkspaceDraft) {
  const files = state.serialize();
  const docs = state.kv.fullDocs.entries().filter(([id]) => state.documents.get(id)?.status === 'processed')
    .map(([id, value]) => {
      const doc = StoredDocumentSchema.parse(value);
      return [id, { name: doc.name, contentHash: doc.contentHash, version: doc.version, content: doc.content ?? null }];
    });
  // A completed rebuild is an explicit cache invalidation even when deterministic vectors have identical bytes.
  const rebuilds=state.jobs.entries().filter(([,job])=>job.operation==='rebuild'&&job.status==='processed').map(([id])=>id);
  return sha(JSON.stringify({ docs, rebuilds, chunks: state.kv.textChunks.entries(),
    graph: files['graph.json'], binding: state.indexBinding ?? null, vectors: [files['vectors-chunks.json'], files['vectors-entities.json'], files['vectors-relations.json']] }));
}
export class PublishedCommitError extends Error {
  readonly published = true;
  constructor(readonly generation: string, readonly durabilityConfirmed: boolean, options: ErrorOptions) {
    super(`Snapshot ${generation} was published; storage is fenced. Inspect and restart; do not blindly replay.`, options);
  }
}

export class SnapshotView {
  constructor(private readonly current: Current) {}
  get indexBinding() { return structuredClone(this.current.state.indexBinding); }
  get cleanupTasks() { return structuredClone(this.current.state.cleanupTasks); }
  get generation() { return this.current.manifest.generation; }
  get revision() { return this.current.manifest.revision; }
  get corpusRevision() { return this.current.manifest.corpusRevision; }
  getKV(namespace: KVName, id: string) { return this.current.state.kv[namespace].get(id); }
  size(namespace: KVName) { return this.current.state.kv[namespace].size; }
  entries(namespace: KVName) { return this.current.state.kv[namespace].entries(); }
  documents() { return this.current.state.documents.entries().map(([, doc]) => doc); }
  jobs() { return this.current.state.jobs.entries().map(([, job]) => job); }
  document(id: string) { return this.current.state.documents.get(id); }
  job(id: string) { return this.current.state.jobs.get(id); }
  conversations() { return this.current.state.conversations.entries().map(([, conversation]) => conversation); }
  conversation(id: string) { return this.current.state.conversations.get(id); }
  browseGraph(query: string, root: string | undefined, limit: number, kind: 'nodes' | 'edges') { return this.current.state.graph.browse(query, root, limit, kind); }
  graphCatalog(kind: 'nodes' | 'edges', offset: number, limit: number) { return this.current.state.graph.catalog(kind, offset, limit); }
  graphSelection(nodeIds: string[], edgeIds: string[]) { return this.current.state.graph.select(nodeIds, edgeIds); }
  node(id: string) { return this.current.state.graph.getNode(id); }
  edgeById(id: string) { return this.current.state.graph.getEdgeById(id); }
  edge(source: string, target: string) { return this.current.state.graph.getEdge(source, target); }
  neighbors(id: string) { return this.current.state.graph.neighbors(id); }
  getVector(namespace: 'chunks' | 'entities' | 'relations', id: string) { return this.current.state.vectors[namespace].get(id); }
  search(namespace: 'chunks' | 'entities' | 'relations', ...args: Parameters<WorkspaceDraft['vectors']['chunks']['search']>) {
    return this.current.state.vectors[namespace].search(...args);
  }
  export() { return this.current.state.serialize(); }
}

export class SnapshotStore {
  private current: Current | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private fenced = false;
  private closePromise: Promise<void> | undefined;
  private constructor(private readonly paths: StoragePaths, private readonly lock: WriterLock,
    private readonly hook?: (point: CommitPoint, file?: string) => Promise<void>) {}

  static async open(dataDir: string, options: { hook?: (point: CommitPoint, file?: string) => Promise<void> } = {}) {
    const paths = await layout(dataDir); const lock = await WriterLock.acquire(paths.root);
    const store = new SnapshotStore(paths, lock, options.hook);
    try {
      if (await hasCurrent(paths)) store.current = await loadCurrent(paths);
      else { await assertFresh(paths); await store.commitInside(() => {}, {}); }
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  get dataDir() { return this.paths.root; }
  get healthy() { return !this.fenced && !this.closed && this.lock.held; }
  capture() { this.assertAvailable(); if (!this.current) throw new Error('Storage not initialized'); return new SnapshotView(this.current); }
  private assertAvailable() { if (!this.healthy) throw new Error('Storage closed or fenced; restart required'); }
  transact(mutate: (draft: WorkspaceDraft) => void, options: { expectedRevision?: number } = {}) {
    if (this.closing) return Promise.reject(new Error('Storage is closing'));
    const work = this.tail.then(() => this.commitInside(mutate, options));
    this.tail = work.then(() => {}, () => {});
    return work;
  }
  private async commitInside(mutate: (draft: WorkspaceDraft) => void, options: { expectedRevision?: number }) {
    this.assertAvailable();
    if (options.expectedRevision !== undefined && options.expectedRevision !== this.current?.manifest.revision) throw new Error('REVISION_CONFLICT');
    const candidate = this.current ? WorkspaceDraft.restore(this.current.state.serialize()) : new WorkspaceDraft();
    const returned: unknown = mutate(candidate);
    if (returned !== undefined) {
      if (returned instanceof Promise) void returned.catch(() => {});
      throw new Error('Storage mutations must be synchronous and return void');
    }
    // Detach all retained draft handles before publishing; validate cross-store references.
    const state = WorkspaceDraft.restore(candidate.serialize());
    const manifest: Manifest = {
      schemaVersion: 1, workspace: 'default', generation: `g-${randomUUID()}`,
      previous: this.current?.pointer ?? null,
      revision: (this.current?.manifest.revision ?? -1) + 1,
      corpusRevision: (this.current?.manifest.corpusRevision ?? 0) + (this.current && corpusIdentity(this.current.state) !== corpusIdentity(state) ? 1 : 0),
      files: Object.fromEntries(FILE_NAMES.map((name) => [name, '0'.repeat(64)])) as Manifest['files'],
    };
    let published = false; let durabilityConfirmed = false; let next: Current | undefined;
    try {
      const pointer = await writeGeneration(this.paths, state, manifest, this.hook);
      next = { state, manifest, pointer };
      await this.hook?.('before-current');
      const temporary = join(this.paths.workspace, `.CURRENT-${randomUUID()}.tmp`);
      await writeNew(temporary, JSON.stringify(pointer));
      await rename(temporary, join(this.paths.workspace, 'CURRENT'));
      published = true;
      await this.hook?.('after-current');
      durabilityConfirmed = await syncDirectory(this.paths.workspace);
      this.current = next;
      await this.hook?.('after-current-sync');
      return { generation: manifest.generation, revision: manifest.revision, corpusRevision: manifest.corpusRevision, published: true as const };
    } catch (error) {
      if (published) {
        this.current = next; this.fenced = true;
        throw new PublishedCommitError(manifest.generation, durabilityConfirmed, { cause: error });
      }
      throw error;
    }
  }
  close() {
    this.closing = true;
    this.closePromise ??= (async () => {
      await this.tail;
      this.closed = true; await this.lock.release();
    })();
    return this.closePromise;
  }
}
