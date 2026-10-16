import { expect, it } from 'vitest';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { controlledDocuments } from '../helpers/controlled-documents.js';
import { startService } from '../helpers/owned-service.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { kgHandler } from '../helpers/indexing.js';
import { textProfile, embeddingProfile, bindings } from '../helpers/model-profiles.js';
import { importText, waitJob } from '../helpers/document-service.js';
import { ImportResultSchema } from '@tslightrag/contracts';
it.each(['SIGKILL','SIGTERM'] as const)('recovers %s during final indexing without publishing partial data or auto-charging', async (signal) => {
  const dir = await temporaryDirectory(); const model = await startFakeModel(kgHandler);
  const first = await controlledDocuments(dir.path,'before-index-final'); let next: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    const saved = await fetch(`${first.address}/api/v1/settings/models`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:0,profiles:[textProfile(model.url),embeddingProfile(model.url)],bindings:{...bindings,rerank:null}})}); expect(saved.status).toBe(200);
    const {result} = await importText(first.address,'first document'); await first.waitCheckpoint(result.job.id); const calls = model.requests.length;
    await first.stop(signal); next = await startService(['--data-dir',dir.path]);
    expect((await waitJob(next.address,result.job.id)).status).toBe('interrupted'); expect(model.requests).toHaveLength(calls);
    const retried = await fetch(`${next.address}/api/v1/documents/${result.document.id}/retry`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedJobId:result.job.id})});
    const job = ImportResultSchema.parse(await retried.json()).job; expect((await waitJob(next.address,job.id)).status).toBe('processed');
    expect(model.requests.filter((r) => !(r.body as {input?:unknown}).input)).toHaveLength(2);
  } finally { if (next) await next.stop(); await first.stop('SIGKILL'); await model.stop(); await dir.cleanup(); }
});
