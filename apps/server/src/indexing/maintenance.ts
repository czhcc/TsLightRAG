import type { DocumentRecord, JobRecord } from '@tslightrag/contracts';
import { ModelClient } from '../models/client.js';
import { boundProfile, embeddingSpaceId } from '../models/config.js';
import type { ModelConfig, ModelConfigStore } from '../models/config.js';
import { ModelError } from '../models/errors.js';
import type { SnapshotStore } from '../storage/snapshot.js';
import { WorkspaceDraft, ChunkSchema, VECTOR_NAMES } from '../storage/state.js';
import { MemoryGraph, edgeId } from '../storage/graph.js';
import { MemoryVectors } from '../storage/vectors.js';
import { JsonSchema } from '../storage/kv.js';
import type { Indexer } from './indexer.js';
import { LedgerSchema, entityId, hash } from './extraction.js';
import { mergeContributions } from './merge.js';
import { summarizeDescriptions } from './summary.js';
import type { Artifact } from '../documents/files.js';

export interface Replacement { document: DocumentRecord; artifact: Artifact; contributions: Awaited<ReturnType<Indexer['prepare']>> }
/** All index writers use Indexer's domain gate; readers retain their old immutable snapshot. */
export class IndexMaintenance {
  constructor(private storage: SnapshotStore, private configs: ModelConfigStore, private indexer: Indexer, private client = new ModelClient()) {}
  async execute(job: JobRecord, config: ModelConfig, signal: AbortSignal, phase: (value:'embedding'|'committing')=>Promise<void>, guard:()=>void,
    finish:(draft:WorkspaceDraft)=>void, replacement?:Replacement) {

      guard(); const base = this.storage.capture();
      if (base.corpusRevision !== job.maintenance!.expectedCorpusRevision) throw new ModelError('INDEX_CONFLICT','语料已变化，请重新发起操作',409);
      const candidate = WorkspaceDraft.restore(base.export()); const removedChunks = new Set<string>();
      const targetIds = job.maintenance?.all ? candidate.documents.entries().map(([id])=>id) : job.documentId ? [job.documentId] : [];
      const sources = new Set<string>(); const artifacts = new Set<string>();
      for (const id of targetIds) {
        const doc = candidate.documents.get(id); if (!doc) throw new ModelError('DOCUMENT_NOT_FOUND','文档已不存在',404);
        if (!job.maintenance?.all && doc.version !== job.maintenance?.sourceVersion) throw new ModelError('DOCUMENT_CONFLICT','文档版本已更新',409);
        if (doc.ingestion) sources.add(doc.ingestion.sourceKey);
        for (const [chunkId,value] of candidate.kv.textChunks.entries()) if (ChunkSchema.parse(value).docId === id) {
          removedChunks.add(chunkId); candidate.kv.textChunks.delete(chunkId); candidate.kv.extractions.delete(chunkId); candidate.vectors.chunks.delete(chunkId);
        }
        if (job.operation === 'delete') {
          candidate.documents.delete(id); candidate.kv.fullDocs.delete(id); candidate.kv.fullEntities.delete(id); candidate.kv.fullRelations.delete(id);
          for (const [key,previous] of candidate.jobs.entries()) if (previous.documentId === id) {
            if (/^j-[a-f0-9-]{36}$/.test(previous.id)) artifacts.add(previous.id);
            if (previous.artifactDocument) sources.add(`${previous.artifactDocument.contentHash}.blob`);
            if (previous.maintenance?.replacement) sources.add(`${previous.maintenance.replacement.contentHash}.blob`);
            candidate.jobs.set(key,{...previous,documentId:null});
          }
        }
      }
      if (replacement) {
        const doc = replacement.document; if(doc.ingestion)sources.delete(doc.ingestion.sourceKey);
        candidate.documents.set(doc.id,doc); candidate.kv.fullDocs.set(doc.id,JsonSchema.parse({...doc,content:replacement.artifact.document.text,chunkIds:replacement.artifact.chunks.map((c)=>c.id)}));
        for (const chunk of replacement.artifact.chunks) candidate.kv.textChunks.set(chunk.id,{id:chunk.id,docId:doc.id,docVersion:doc.version,order:chunk.order,content:chunk.content,tokens:chunk.tokens,location:JSON.stringify(chunk.locations),indexVersion:'s06-json-v1'});
        for (const c of replacement.contributions) candidate.kv.extractions.set(c.chunkId,JsonSchema.parse(c.ledger));
      }
      const oldGraph = candidate.graph.serialize(); const affected = new Set<string>();
      for (const record of [...oldGraph.nodes,...oldGraph.edges]) if (record.sourceChunkIds.some((id)=>removedChunks.has(id))) affected.add(record.id);
      for (const c of replacement?.contributions ?? []) {
        for (const e of c.value.entities) affected.add(entityId(e.name));
        for (const r of c.value.relationships) affected.add(edgeId(entityId(r.source),entityId(r.target)));
      }
      if (job.operation !== 'rebuild') {
        const contributions = [];
        for (const [chunkId,value] of candidate.kv.extractions.entries()) {
          const parsed = LedgerSchema.safeParse(value);
          if (parsed.success) contributions.push({chunkId,value:parsed.data.contribution});
          else if ([...oldGraph.nodes,...oldGraph.edges].some((r)=>affected.has(r.id)&&r.sourceChunkIds.includes(chunkId))) throw new ModelError('CONTRIBUTIONS_REQUIRED','存活来源缺少原始贡献，无法安全重建共享图',409);
        }
        const rebuilt = mergeContributions(contributions,[],[]); const text = boundProfile(config,'extract');
        const names = new Map([...oldGraph.nodes,...rebuilt.nodes].map((n)=>[n.id,n.name]));
        for (const record of [...rebuilt.nodes,...rebuilt.edges]) if (affected.has(record.id)) {
          const descriptions = rebuilt.descriptions.get(record.id)!;
          if (descriptions.length === 1) record.description = descriptions[0]!;
          else {
            if (text?.kind !== 'text') throw new ModelError('MODEL_NOT_CONFIGURED','共享描述重建缺少文本模型',409);
            record.description = await summarizeDescriptions(this.client,text,'name' in record ? record.name : `${names.get(record.sourceId)!} / ${names.get(record.targetId)!}`,descriptions,signal);
          }
        }
        candidate.graph = new MemoryGraph();
        for (const node of [...oldGraph.nodes.filter((n)=>!affected.has(n.id)),...rebuilt.nodes.filter((n)=>affected.has(n.id))]) candidate.graph.setNode(node);
        for (const edge of [...oldGraph.edges.filter((e)=>!affected.has(e.id)),...rebuilt.edges.filter((e)=>affected.has(e.id))]) candidate.graph.setEdge(edge);
        for (const id of affected) { candidate.vectors.entities.delete(id); candidate.vectors.relations.delete(id); }
      }
      const graph = candidate.graph.serialize();
      const target = job.operation === 'rebuild' ? config.profiles.find((p)=>p.id===job.maintenance?.targetProfileId) : boundProfile(config,'embedding');
      const rows = [
        ...candidate.kv.textChunks.entries().map(([id,value])=>({namespace:'chunks' as const,id,content:ChunkSchema.parse(value).content})),
        ...graph.nodes.map((n)=>({namespace:'entities' as const,id:n.id,content:`${n.name}\n${n.type}\n${n.description}`})),
        ...graph.edges.map((e)=>({namespace:'relations' as const,id:e.id,content:`${candidate.graph.getNode(e.sourceId)!.name}\n${candidate.graph.getNode(e.targetId)!.name}\n${e.keywords.join(', ')}\n${e.description}`})),
      ].filter((r)=>job.operation==='rebuild'||affected.has(r.id)||(r.namespace==='chunks'&&Boolean(replacement?.artifact.chunks.some((c)=>c.id===r.id))));
      await phase('embedding');
      if (rows.length || job.operation === 'rebuild') {
        if (target?.kind !== 'embedding') throw new ModelError('MODEL_NOT_CONFIGURED','缺少目标向量模型',409);
        const spaceId = embeddingSpaceId(target)!;
        if (job.operation === 'rebuild') for (const name of VECTOR_NAMES) candidate.vectors[name] = new MemoryVectors({id:spaceId,dimensions:target.dimensions,normalization:'l2'});
        for (let offset=0;offset<rows.length;offset+=256) {
          guard(); const batch=rows.slice(offset,offset+256); const vectors=await this.client.embed(target,batch.map((r)=>r.content),signal);
          for (const [i,row] of batch.entries()) candidate.vectors[row.namespace].set({id:row.id,values:vectors[i]!,contentHash:hash(row.content),metadata:{content:row.content}},spaceId);
        }
        candidate.indexBinding = job.operation==='rebuild' ? {profileId:target.id,configRevision:config.revision,spaceId} : this.configs.bindingForIndex(config);
      }
      if (!candidate.kv.textChunks.entries().length && job.operation!=='rebuild') { candidate.indexBinding=undefined; for (const name of VECTOR_NAMES) candidate.vectors[name]=new MemoryVectors(); }
      // Destructive changes invalidate both extraction and future retrieval/answer caches.
      candidate.kv.caches.clear();
      for (const name of ['fullEntities','fullRelations','entityChunks','relationChunks'] as const) candidate.kv[name].clear();
      for (const node of graph.nodes) candidate.kv.entityChunks.set(node.id,node.sourceChunkIds);
      for (const edge of graph.edges) candidate.kv.relationChunks.set(edge.id,edge.sourceChunkIds);
      for (const [id,doc] of candidate.documents.entries()) if (doc.status==='processed') {
        const chunks=new Set(candidate.kv.textChunks.entries().filter(([,v])=>ChunkSchema.parse(v).docId===id).map(([key])=>key));
        candidate.kv.fullEntities.set(id,graph.nodes.filter((n)=>n.sourceChunkIds.some((c)=>chunks.has(c))).map((n)=>n.id).sort());
        candidate.kv.fullRelations.set(id,graph.edges.filter((e)=>e.sourceChunkIds.some((c)=>chunks.has(c))).map((e)=>e.id).sort());
      }
      await phase('committing'); guard();
      await this.indexer.exclusive(()=>this.configs.withRevision(config.revision,()=>this.storage.transact((draft)=>{
        guard(); if (this.storage.capture().corpusRevision!==base.corpusRevision) throw new ModelError('INDEX_CONFLICT','语料已变化，请重新发起操作',409);
        for (const id of targetIds) {
          const doc=candidate.documents.get(id);
          if (doc) { draft.documents.set(id,doc); draft.kv.fullDocs.set(id,candidate.kv.fullDocs.get(id)!); }
          else { draft.documents.delete(id); draft.kv.fullDocs.delete(id); for (const [key,previous] of draft.jobs.entries()) if(previous.documentId===id) draft.jobs.set(key,{...previous,documentId:null}); }
        }
        for (const name of ['textChunks','extractions','fullEntities','fullRelations','entityChunks','relationChunks'] as const) draft.kv[name]=candidate.kv[name];
        draft.kv.caches.clear(); draft.graph=candidate.graph; draft.vectors=candidate.vectors; draft.indexBinding=candidate.indexBinding;
        if (sources.size||artifacts.size) draft.cleanupTasks.push({id:`clean-${job.id}`,sourceKeys:[...sources],artifactIds:[...artifacts],status:'pending',attempts:0,error:null});
        finish(draft);
      })));
  }
}
