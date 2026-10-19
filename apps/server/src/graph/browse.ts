import { ChunkSchema, GraphSourcesSchema } from '@tslightrag/contracts';
import type { GraphSourcesQuerySchema } from '@tslightrag/contracts';
import type { z } from 'zod';
import type { SnapshotView } from '../storage/snapshot.js';
import { DocumentError } from '../documents/files.js';

export function graphSources(view: SnapshotView, query: z.infer<typeof GraphSourcesQuerySchema>) {
  const record = query.kind === 'node' ? view.node(query.id) : view.edgeById(query.id);
  if (!record) throw new DocumentError('GRAPH_ITEM_NOT_FOUND', '节点或关系已不存在，请刷新图谱', 404);
  const items = record.sourceChunkIds.slice(query.offset, query.offset + query.limit).map((id) => {
    const chunk = ChunkSchema.parse(view.getKV('textChunks', id));
    const document = view.document(chunk.docId);
    if (!document) throw new Error('Graph source document missing');
    return { chunk, fileName: document.name, documentVersion: chunk.docVersion };
  });
  return GraphSourcesSchema.parse({ items, total: record.sourceChunkIds.length, offset: query.offset, corpusRevision: view.corpusRevision });
}
