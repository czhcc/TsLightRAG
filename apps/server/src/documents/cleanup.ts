import { readdir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { CleanupTaskSchema } from '@tslightrag/contracts';
import type { SnapshotStore } from '../storage/snapshot.js';
import { ManifestSchema, sha } from '../storage/disk.js';
import { directory, readRegular, syncDirectory } from '../storage/io.js';

/** Retained generations are references too: preserve rollback inputs until those generations retire. */
export async function cleanupFiles(storage: SnapshotStore, task: z.infer<typeof CleanupTaskSchema>) {
  const roots=join(storage.dataDir,'workspace/default/generations'); await directory(roots);
  const wantedSources=new Set(task.sourceKeys); const wantedArtifacts=new Set(task.artifactIds);
  for (const entry of await readdir(roots,{withFileTypes:true})) {
    if (!/^g-[a-f0-9-]{36}$/.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink()) throw new Error('Unsafe retained generation');
    const path=join(roots,entry.name); await directory(path);
    let kv:{fullDocs:[string,{ingestion?:{sourceKey:string}}][]}; let status:{jobs:{documentId:string|null;result?:{artifactKey:string};maintenance?:{replacement?:{contentHash:string}}}[][]};
    try { const kvText=await readRegular(join(path,'kv.json'));const statusText=await readRegular(join(path,'document-status.json'));const manifest=ManifestSchema.parse(JSON.parse(await readRegular(join(path,'manifest.json'))));if(manifest.generation!==entry.name||sha(kvText)!==manifest.files['kv.json']||sha(statusText)!==manifest.files['document-status.json'])return 'retained' as const;kv=JSON.parse(kvText) as typeof kv; status=JSON.parse(statusText) as typeof status; }
    catch { return 'retained' as const; } // Incomplete/corrupt history cannot prove that release is safe.
    if (!Array.isArray(kv.fullDocs)||!Array.isArray(status.jobs)) return 'retained' as const;
    for (const [,doc] of kv.fullDocs) if(doc.ingestion&&wantedSources.has(doc.ingestion.sourceKey)) return 'retained' as const;
    for (const row of status.jobs) { const job=row[1]; if(!job) return 'retained' as const;
      if (job.documentId && job.result && wantedArtifacts.has(job.result.artifactKey.split('/')[0]!)) return 'retained' as const;
      if (job.documentId&&job.maintenance?.replacement&&wantedSources.has(`${job.maintenance.replacement.contentHash}.blob`)) return 'retained' as const;
    }
  }
  const sources=join(storage.dataDir,'documents'); const staging=join(storage.dataDir,'staging'); await directory(sources); await directory(staging);
  const remove = async (path:string) => { try {await unlink(path);} catch(error) {if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;} };
  for(const key of task.sourceKeys) await remove(join(sources,key)); await syncDirectory(sources);
  for(const id of task.artifactIds) {
    const path=join(staging,id); await directory(path); await remove(join(path,'prepared.json')); await syncDirectory(path);
    try {await rmdir(path);} catch(error) {if(!(error instanceof Error&&'code' in error&&error.code==='ENOTEMPTY'))throw error;}
  }
  await syncDirectory(staging); return 'done' as const;
}
