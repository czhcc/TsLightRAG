import { expect, it } from 'vitest';
import { GraphDataSchema, GraphSourcesSchema } from '@tslightrag/contracts';
import { indexingHarness } from '../helpers/indexing.js';

it('browses a bounded committed graph, expands neighbors and paginates actual source documents without model calls', async () => {
  const h = await indexingHarness();
  try {
    for (const text of ['first document Alpha Beta', 'second document Alpha Beta Gamma']) {
      const doc = await h.import(text); expect((await h.wait(doc.job.id)).status).toBe('processed');
    }
    const calls = h.model.requests.length;
    const read = async (url: string) => {
      const response = await h.app.inject({ url }); expect(response.statusCode).toBe(200); return response.json();
    };
    const all = GraphDataSchema.parse(await read('/api/v1/graph?limit=2'));
    expect(all.totalNodes).toBe(3); expect(all.nodes).toHaveLength(2); expect(all.truncated).toBe(true);
    expect(all.edges.every(e => all.nodes.some(n => n.id === e.sourceId) && all.nodes.some(n => n.id === e.targetId))).toBe(true);
    const search = GraphDataSchema.parse(await read('/api/v1/graph?q=alpha'));
    expect(search.nodes.map(n => n.name)).toEqual(['Alpha']); expect(search.nodes[0]!.sourceCount).toBe(2);
    expect(JSON.stringify(search)).not.toContain('sourceChunkIds');
    const neighbors = GraphDataSchema.parse(await read(`/api/v1/graph?nodeId=${search.nodes[0]!.id}`));
    expect(neighbors.nodes).toHaveLength(3); expect(neighbors.edges).toHaveLength(2);
    const edgeSearch = GraphDataSchema.parse(await read('/api/v1/graph?kind=edges&q=cooperate'));
    expect(edgeSearch.edges).toHaveLength(1); expect(edgeSearch.nodes.map(n => n.name)).toEqual(['Alpha', 'Beta']);
    expect(GraphDataSchema.parse(await read('/api/v1/graph?kind=edges&q=absent')).nodes).toHaveLength(0);
    const sources = GraphSourcesSchema.parse(await read(`/api/v1/graph/sources?kind=node&id=${search.nodes[0]!.id}&limit=1`));
    expect(sources.total).toBe(2); expect(sources.items).toHaveLength(1);
    expect(sources.items[0]!.fileName).toBe('knowledge.txt'); expect(sources.items[0]!.chunk.content).toContain('document');
    const next = GraphSourcesSchema.parse(await read(`/api/v1/graph/sources?kind=node&id=${search.nodes[0]!.id}&limit=1&offset=1`));
    expect(next.items[0]!.chunk.id).not.toBe(sources.items[0]!.chunk.id);
    const edge = neighbors.edges[0]!;
    const edgeSources = GraphSourcesSchema.parse(await read(`/api/v1/graph/sources?kind=edge&id=${edge.id}`));
    expect(edgeSources.items.length).toBe(edge.sourceCount);
    expect(h.model.requests).toHaveLength(calls);
    for (const query of ['limit=101', 'limit=0', 'limit=1.5', 'extra=1']) expect((await h.app.inject({ url: `/api/v1/graph?${query}` })).statusCode).toBe(400);
    expect((await h.app.inject({ url: '/api/v1/graph?nodeId=missing' })).statusCode).toBe(404);
    expect((await h.app.inject({ url: '/api/v1/graph/sources?kind=node&id=missing' })).statusCode).toBe(404);
    expect((await h.app.inject({ url: `/api/v1/graph/sources?kind=node&id=${search.nodes[0]!.id}&limit=21` })).statusCode).toBe(400);
  } finally { await h.close(); }
});

it('filters names and status before pagination and rejects invalid document filters', async () => {
  const h = await indexingHarness();
  try {
    for (const text of ['first document', 'second document']) { const doc = await h.import(text); await h.wait(doc.job.id); }
    const response = await h.app.inject({ url: '/api/v1/documents?q=KNOWLEDGE&status=processed&limit=1&offset=1' });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ total: 2, offset: 1 }); expect(response.json().items).toHaveLength(1);
    expect((await h.app.inject({ url: '/api/v1/documents?q=absent' })).json().total).toBe(0);
    expect((await h.app.inject({ url: '/api/v1/documents?status=failed' })).json().total).toBe(0);
    expect((await h.app.inject({ url: '/api/v1/documents?status=not-a-status' })).statusCode).toBe(400);
  } finally { await h.close(); }
});
