import type { GraphData } from '@tslightrag/contracts';
export type GraphLayout = 'force' | 'circle' | 'grid' | 'hierarchy';
export type Point = { x: number; y: number };
export const GRAPH_WIDTH = 1000, GRAPH_HEIGHT = 650;
export function graphLayout(nodes: GraphData['nodes'], edges: GraphData['edges'], layout: GraphLayout): Map<string, Point> {
  const points = new Map<string, Point>();
  nodes.forEach((node, i) => points.set(node.id, nodes.length === 1 ? { x: 500, y: 325 } : {
    x: 500 + 410 * Math.cos(2 * Math.PI * i / nodes.length), y: 325 + 245 * Math.sin(2 * Math.PI * i / nodes.length),
  }));
  if (layout === 'circle' || nodes.length < 2) return points;
  if (layout === 'grid') {
    const columns = Math.ceil(Math.sqrt(nodes.length * GRAPH_WIDTH / GRAPH_HEIGHT)), rows = Math.ceil(nodes.length / columns);
    nodes.forEach((node, i) => points.set(node.id, { x: 70 + (i % columns + .5) * 860 / columns, y: 50 + (Math.floor(i / columns) + .5) * 530 / rows }));
    return points;
  }
  if (layout === 'hierarchy') {
    const neighbors = new Map(nodes.map(n => [n.id, [] as string[]]));
    for (const e of edges) if (neighbors.has(e.sourceId) && neighbors.has(e.targetId)) { neighbors.get(e.sourceId)!.push(e.targetId); neighbors.get(e.targetId)!.push(e.sourceId); }
    const seen = new Set<string>(), levels: string[][] = [];
    for (const root of nodes) {
      if (seen.has(root.id)) continue;
      const queue: [string, number][] = [[root.id, 0]]; seen.add(root.id);
      for (let i = 0; i < queue.length; i++) {
        const [id, level] = queue[i]!; (levels[level] ??= []).push(id);
        for (const next of neighbors.get(id)!) if (!seen.has(next)) { seen.add(next); queue.push([next, level + 1]); }
      }
    }
    levels.forEach((ids, level) => ids.forEach((id, i) => points.set(id, { x: 60 + (i + 1) * 880 / (ids.length + 1), y: levels.length === 1 ? 325 : 60 + level * 500 / (levels.length - 1) })));
    return points;
  }
  // Bounded deterministic force layout, with no timer or random positions.
  const vertices = nodes.map(n => points.get(n.id)!), indices = new Map(nodes.map((n, i) => [n.id, i]));
  const links = edges.filter(e => indices.has(e.sourceId) && indices.has(e.targetId));
  const ideal = Math.sqrt(440000 / nodes.length);
  for (let step = 0; step < 70; step++) {
    const movement = vertices.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < vertices.length; a++) for (let b = a + 1; b < vertices.length; b++) {
      const dx = vertices[a]!.x - vertices[b]!.x, dy = vertices[a]!.y - vertices[b]!.y;
      const distance = Math.max(1, Math.hypot(dx, dy)), force = ideal * ideal / distance;
      const x = dx / distance * force, y = dy / distance * force;
      movement[a]!.x += x; movement[a]!.y += y; movement[b]!.x -= x; movement[b]!.y -= y;
    }
    for (const edge of links) {
      const a = indices.get(edge.sourceId)!, b = indices.get(edge.targetId)!;
      const dx = vertices[a]!.x - vertices[b]!.x, dy = vertices[a]!.y - vertices[b]!.y;
      const distance = Math.max(1, Math.hypot(dx, dy)), force = distance * distance / ideal;
      const x = dx / distance * force, y = dy / distance * force;
      movement[a]!.x -= x; movement[a]!.y -= y; movement[b]!.x += x; movement[b]!.y += y;
    }
    const temperature = 30 * (1 - step / 70);
    vertices.forEach((p, i) => {
      const move = movement[i]!, distance = Math.max(1, Math.hypot(move.x, move.y));
      p.x = Math.max(60, Math.min(940, p.x + move.x / distance * Math.min(distance, temperature)));
      p.y = Math.max(45, Math.min(590, p.y + move.y / distance * Math.min(distance, temperature)));
    });
  }
  return points;
}
