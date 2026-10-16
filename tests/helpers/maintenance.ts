import { JobSchema } from '@tslightrag/contracts';
import type { indexingHarness } from './indexing.js';
export type Harness=Awaited<ReturnType<typeof indexingHarness>>;
export async function maintain(h:Harness, operation:'delete'|'reindex'|'rebuild'|'clear', id?:string, extra:Record<string,unknown>={}) {
  const config=(await h.app.inject({url:'/api/v1/settings/models'})).json() as {revision:number};
  const path=operation==='clear'?'/api/v1/documents':operation==='rebuild'?'/api/v1/maintenance/rebuild':`/api/v1/documents/${id!}${operation==='reindex'?'/reindex':''}`;
  const response=await h.app.inject({method:operation==='delete'||operation==='clear'?'DELETE':'POST',url:path,payload:{expectedCorpusRevision:h.storage.capture().corpusRevision,expectedConfigRevision:config.revision,...(id?{expectedDocumentVersion:h.storage.capture().document(id)!.version}:{}),...extra}});
  if(response.statusCode!==202)throw new Error(response.body);return JobSchema.parse(response.json());
}
export async function candidate(h:Harness, patch:Record<string,unknown>) {
  const settings=(await h.app.inject({url:'/api/v1/settings/models'})).json() as {revision:number;profiles:Record<string,unknown>[];bindings:Record<string,unknown>};
  const profiles=settings.profiles.map((p)=>{const copy={...p};delete copy.hasApiKey;return p.kind==='embedding'?{...copy,...patch}:copy;});
  const response=await h.app.inject({method:'PUT',url:'/api/v1/settings/models',payload:{expectedRevision:settings.revision,profiles,bindings:settings.bindings}});
  if(response.statusCode!==200)throw new Error(response.body);return response.json() as {revision:number;embeddingSpaceId:string;activeIndex:{spaceId:string;configRevision:number;profile:Record<string,unknown>}};
}
