import { createHash } from 'node:crypto';
import { EntitySchema, RelationSchema } from '@tslightrag/contracts';
import { z } from 'zod';

export type GraphNode = z.infer<typeof EntitySchema>;
export type GraphEdge = z.infer<typeof RelationSchema>;
export const GraphFileSchema = z.strictObject({ nodes: z.array(EntitySchema), edges: z.array(RelationSchema) });
export function edgeId(source: string, target: string) {
  return `rel-${createHash('sha256').update(JSON.stringify([source, target].sort())).digest('hex')}`;
}
export class MemoryGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly adjacent = new Map<string, Set<string>>();
  get nodeCount() { return this.nodes.size; }
  get edgeCount() { return this.edges.size; }
  setNode(input: GraphNode) {
    const node = EntitySchema.parse(input);
    node.sourceChunkIds = [...new Set(node.sourceChunkIds)];
    this.nodes.set(node.id, structuredClone(node));
    if (!this.adjacent.has(node.id)) this.adjacent.set(node.id, new Set());
  }
  getNode(id: string) { return structuredClone(this.nodes.get(id)); }
  setEdge(input: Omit<GraphEdge, 'id'>) {
    const [sourceId, targetId] = [input.sourceId, input.targetId].sort();
    const edge = RelationSchema.parse({ ...input, sourceId, targetId, id: edgeId(input.sourceId, input.targetId) });
    if (!this.nodes.has(edge.sourceId) || !this.nodes.has(edge.targetId)) throw new Error('Dangling graph endpoint');
    edge.sourceChunkIds = [...new Set(edge.sourceChunkIds)];
    this.edges.set(edge.id, structuredClone(edge));
    this.adjacent.get(edge.sourceId)?.add(edge.targetId);
    this.adjacent.get(edge.targetId)?.add(edge.sourceId);
    return edge.id;
  }
  getEdge(source: string, target: string) { return structuredClone(this.edges.get(edgeId(source, target))); }
  neighbors(id: string) { return [...(this.adjacent.get(id) ?? [])]; }
  degree(id: string) {
    const neighbors = this.adjacent.get(id);
    return (neighbors?.size ?? 0) + (neighbors?.has(id) ? 1 : 0);
  }
  edgeDegree(source: string, target: string) { return this.degree(source) + this.degree(target); }
  deleteEdge(source: string, target: string) {
    const removed = this.edges.delete(edgeId(source, target));
    this.adjacent.get(source)?.delete(target); this.adjacent.get(target)?.delete(source);
    return removed;
  }
  deleteNode(id: string) {
    for (const neighbor of this.neighbors(id)) this.deleteEdge(id, neighbor);
    this.adjacent.delete(id); return this.nodes.delete(id);
  }
  serialize() { return { nodes: [...this.nodes.values()].map((v) => structuredClone(v)), edges: [...this.edges.values()].map((v) => structuredClone(v)) }; }
  static restore(input: unknown) {
    const file = GraphFileSchema.parse(input); const graph = new MemoryGraph();
    for (const node of file.nodes) {
      if (graph.nodes.has(node.id) || new Set(node.sourceChunkIds).size !== node.sourceChunkIds.length) throw new Error('Duplicate graph node or source');
      graph.setNode(node);
    }
    for (const edge of file.edges) {
      if (edge.id !== edgeId(edge.sourceId, edge.targetId) || edge.sourceId > edge.targetId || graph.edges.has(edge.id)
        || new Set(edge.sourceChunkIds).size !== edge.sourceChunkIds.length) throw new Error('Invalid canonical graph edge');
      graph.setEdge(edge);
    }
    return graph;
  }
}
