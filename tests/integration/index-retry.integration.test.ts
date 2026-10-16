import { expect, it } from 'vitest';
import { indexingHarness, kgHandler, reply } from '../helpers/indexing.js';
import { ImportResultSchema } from '@tslightrag/contracts';
it('retries embedding failures using valid extraction cache without duplicating contributions', async () => {
  let fail = true; const h = await indexingHarness({ handler: (req,res) => {
    if ((req.body as {input?:unknown}).input && fail) res.writeHead(500).end('failed'); else kgHandler(req,res);
  } });
  try {
    const first = await h.import('first document'); expect((await h.wait(first.job.id)).status).toBe('failed');
    const chatCalls = () => h.model.requests.filter((r) => !(r.body as {input?:unknown}).input).length;
    expect(chatCalls()).toBe(2); fail = false;
    const response = await h.app.inject({ method: 'POST', url: `/api/v1/documents/${first.document.id}/retry`, payload: { expectedJobId: first.job.id } });
    const next = ImportResultSchema.parse(response.json()); expect((await h.wait(next.job.id)).status).toBe('processed'); expect(chatCalls()).toBe(2);
    expect(h.storage.capture().entries('extractions')).toHaveLength(1);
    const graph = h.storage.capture().export()['graph.json'] as {nodes:unknown[];edges:{weight:number}[]};
    expect(graph.nodes).toHaveLength(2); expect(graph.edges).toHaveLength(1); expect(graph.edges[0]?.weight).toBe(2);
  } finally { await h.close(); }
});
it('never caches failed or invalid extraction as a success', async () => {
  const h = await indexingHarness({ handler: (_req,res) => { reply(res,'not JSON'); } });
  try { const a = await h.import('first document'); expect((await h.wait(a.job.id)).errorCode).toBe('EXTRACTION_INVALID'); expect(h.storage.capture().entries('caches')).toEqual([]); expect(h.storage.capture().entries('extractions')).toEqual([]); }
  finally { await h.close(); }
});
it('cancellation at final publication leaves no partial graph or vectors', async () => {
  let ready = false; let release: (()=>void) | undefined;
  const h = await indexingHarness({ documentOptions: { hook: async (point, _job, signal) => {
    if (point !== 'before-index-final') return; ready = true;
    await new Promise<void>((resolve) => { release = resolve; signal.addEventListener('abort', () => { resolve(); }, {once:true}); });
  } } });
  try {
    const a = await h.import('first document'); await expect.poll(() => ready, {timeout: 10000}).toBe(true);
    await h.app.inject({method:'POST',url:`/api/v1/jobs/${a.job.id}/cancel`}); release?.();
    expect((await h.wait(a.job.id)).status).toBe('cancelled'); expect(h.storage.capture().entries('textChunks')).toEqual([]); expect(h.storage.capture().corpusRevision).toBe(0);
  } finally { release?.(); await h.close(); }
});
it('rejects a configuration change during embedding before any index is published', async () => {
  let release: (()=>void) | undefined;
  const h = await indexingHarness({handler:(req,res) => {
    if ((req.body as {input?:unknown}).input) release = () => { if (!res.writableEnded) kgHandler(req,res); }; else kgHandler(req,res);
  }});
  try {
    const a = await h.import('first document'); await expect.poll(() => Boolean(release), {timeout:10000}).toBe(true);
    const current = (await h.app.inject({url:'/api/v1/settings/models'})).json() as {profiles: {hasApiKey:boolean}[];bindings:unknown};
    const profiles = current.profiles.map((p) => { const copy: Record<string,unknown> = {...p}; delete copy.hasApiKey; return copy; });
    expect((await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:1,profiles,bindings:current.bindings}})).statusCode).toBe(200);
    release!(); expect((await h.wait(a.job.id)).errorCode).toBe('CONFIG_CHANGED'); expect(h.storage.capture().entries('textChunks')).toEqual([]);
  } finally { release?.(); await h.close(); }
});
