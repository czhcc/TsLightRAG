import type { GraphNode, GraphEdge } from '../storage/graph.js';
import { edgeId } from '../storage/graph.js';
import { entityId, sanitizeDescription } from './extraction.js';
import type { Extraction } from './extraction.js';

export type Contribution = { chunkId: string; value: Extraction };
const unique = (values: string[]) => [...new Set(values)];
export const deduplicateDescriptions = (values: string[]) => unique(values.map(sanitizeDescription).filter(Boolean));
/** Add each source exactly once. The ledger remains authoritative for future deletion/rebuild. */
export function mergeContributions(contributions: Contribution[], oldNodes: GraphNode[], oldEdges: GraphEdge[]) {
  const nodes = new Map(oldNodes.map((n) => [n.id, structuredClone(n)]));
  const edges = new Map(oldEdges.map((e) => [e.id, structuredClone(e)]));
  const descriptions = new Map<string, string[]>();
  const types = new Map<string, string[]>();
  for (const { chunkId, value } of contributions) {
    for (const e of value.entities) {
      const id = entityId(e.name); const old = nodes.get(id);
      if (old?.sourceChunkIds.includes(chunkId)) continue;
      descriptions.set(id, deduplicateDescriptions([...(descriptions.get(id) ?? (old ? old.description.split('<SEP>') : [])), e.description]));
      types.set(id, [...(types.get(id) ?? (old ? [old.type] : [])), e.type]);
      nodes.set(id, { id, name: e.name, type: e.type, description: e.description,
        sourceChunkIds: unique([...(old?.sourceChunkIds ?? []), chunkId]).sort() });
    }
    for (const r of value.relationships) {
      const [sourceId, targetId] = [entityId(r.source), entityId(r.target)].sort() as [string, string];
      const id = edgeId(sourceId, targetId); const old = edges.get(id);
      if (old?.sourceChunkIds.includes(chunkId)) continue;
      const sourceChunkIds = unique([...(old?.sourceChunkIds ?? []), chunkId]).sort();
      descriptions.set(id, deduplicateDescriptions([...(descriptions.get(id) ?? (old ? old.description.split('<SEP>') : [])), r.description]));
      edges.set(id, { id, sourceId, targetId, description: r.description, sourceChunkIds,
        weight: (old?.weight ?? 0) + r.strength,
        keywords: unique([...(old?.keywords ?? []), ...r.keywords.split(',').map((v) => v.trim())]).sort() });
    }
  }
  for (const [id, votes] of types) {
    const frequency = (v: string) => votes.filter((x) => x === v).length;
    nodes.get(id)!.type = [...new Set(votes)].sort((a, b) => frequency(b) - frequency(a) || a.localeCompare(b))[0]!;
  }
  for (const [id, fragments] of descriptions) {
    const record = nodes.get(id) ?? edges.get(id); if (record) record.description = fragments.join('<SEP>');
  }
  for (const edge of edges.values()) edge.weight = Math.max(edge.weight, edge.sourceChunkIds.length);
  return { nodes: [...nodes.values()], edges: [...edges.values()], descriptions };
}
