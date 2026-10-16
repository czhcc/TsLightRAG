import type { Query, QueryData, ModelProfileInput } from '@tslightrag/contracts';
import type { GraphNode,GraphEdge } from '../storage/graph.js';
import type { SnapshotView } from '../storage/snapshot.js';
import type { Message } from '../models/client.js';
import { countTokens } from '../core/tokenizer.js';
import { render } from '../indexing/prompts.js';
import { retrievalPrompts } from './prompts.js';
import { relationEndpoints } from './algorithms.js';
import { ModelError } from '../models/errors.js';
export type QueryChunk=QueryData['chunks'][number];
export const entityRecord=(n:GraphNode)=>({entity:n.name,type:n.type,description:n.description});
export const relationRecord=(e:GraphEdge,view:SnapshotView)=>{const [a,b]=relationEndpoints(view,e);return {entity1:view.node(a)?.name??a,entity2:view.node(b)?.name??b,description:e.description};};
// Match ensure_ascii=False JSON spacing used by the upstream graph truncation stage.
export function contextJson(value:Record<string,string>) { return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+': '+JSON.stringify(v)).join(', ')+'}'; }
export function prefixBudget<T>(rows:T[],limit:number,encode:(rows:T[])=>number) { let n=0;for(let i=1;i<=rows.length;i++){if(encode(rows.slice(0,i))>limit)break;n=i;}return rows.slice(0,n); }
export function buildContext(view:SnapshotView,query:Query,profile:Extract<ModelProfileInput,{kind:'text'}>,entities:GraphNode[],relationships:GraphEdge[],chunks:QueryChunk[]){
  const limit=Math.min(query.maxTotalTokens,profile.contextTokens);
  const count=(s:string)=>countTokens(s,profile.tokenizer);
  const create=(nodes:GraphNode[],edges:GraphEdge[],rows:QueryChunk[])=>{
    // References are scoped to document ID AND published version, never a possibly duplicated filename.
    const refs:QueryData['references']=[];const documents=new Map<string,string>();
    const linked=rows.map(c=>{const key=`${c.docId}:${String(c.docVersion)}`;let id=documents.get(key);
      if(!id){id=String(refs.length+1);documents.set(key,id);const doc=view.document(c.docId);refs.push({id,documentId:c.docId,fileName:doc?.name??c.docId,chunkIds:[]});}
      refs.find(r=>r.id===id)!.chunkIds.push(c.id);return {...c,referenceId:id};});
    const originalIds=new Map(refs.map(r=>[r.documentId,r.id]));
    refs.sort((a,b)=>b.chunkIds.length-a.chunkIds.length);
    const remap=new Map<string,string>();
    refs.forEach((r,i)=>{remap.set(originalIds.get(r.documentId)!,String(i+1));r.id=String(i+1);});
    for(const c of linked)c.referenceId=remap.get(c.referenceId)!;
    const context=render(retrievalPrompts.kg_query_context,{
      entities_str:nodes.map(n=>contextJson(entityRecord(n))).join('\n'),
      relations_str:edges.map(e=>contextJson(relationRecord(e,view))).join('\n'),
      text_chunks_str:linked.map(c=>JSON.stringify({reference_id:c.referenceId,content:c.content})).join('\n'),
      reference_list_str:refs.map(r=>`[${r.id}] ${r.fileName}`).join('\n'),
    });
    const system=render(retrievalPrompts.rag_response,{response_type:'Multiple Paragraphs',user_prompt:query.userPrompt??'',context_data:context});
    const messages:Message[]=[{role:'system',content:system},...query.conversationHistory,{role:'user',content:query.query}];
    // Chat framing is conservatively charged in addition to exact tokenizer text counts.
    const inputTokens=3+messages.reduce((n,m)=>n+4+count(m.role)+count(m.content),0);
    return {context,prompt:messages.map(m=>`---${m.role}---\n${m.content}`).join('\n\n'),messages,chunks:linked,references:refs,budget:{limit,inputTokens,reservedOutputTokens:profile.maxOutputTokens,totalTokens:inputTokens+profile.maxOutputTokens}};
  };
  // Contexts are previews of the real generation request, including history and answer reserve.
  if(create([],[],[]).budget.totalTokens>limit)throw new ModelError('QUERY_BUDGET_EXCEEDED','问题、历史、系统提示和回答预留超过上下文预算',400);
  let nodes=entities,edges=relationships,rows=chunks;let result=create(nodes,edges,rows);
  while(result.budget.totalTokens>limit){if(rows.length) rows=rows.slice(0,-1);else if(edges.length)edges=edges.slice(0,-1);else nodes=nodes.slice(0,-1);result=create(nodes,edges,rows);}
  return {...result,entities:nodes,relationships:edges};
}
