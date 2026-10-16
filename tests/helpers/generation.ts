import type { ModelRequest } from './fake-model.js';
import type { ServerResponse } from 'node:http';
import { retrievalHarness,queryHandler } from './retrieval.js';
import { reply } from './indexing.js';
import { StreamEventSchema } from '@tslightrag/contracts';
import type { StreamEvent } from '@tslightrag/contracts';
export function isGeneration(request:ModelRequest){return (request.body as {messages?:{role:string;content:string}[]}).messages?.[0]?.content.includes('expert AI assistant specializing in synthesizing')??false;}
export function generationHandler(request:ModelRequest,response:ServerResponse){if(isGeneration(request))reply(response,'Alpha 与 Beta 协作 [1]。');else queryHandler(request,response);}
export async function generationHarness(handler=generationHandler){return retrievalHarness(handler);}
export function events(raw:string){return raw.trim().split('\n').filter(Boolean).map(line=>StreamEventSchema.parse(JSON.parse(line)));}
export async function collect(response:Response){return events(await response.text());}
export function sseDelta(text:string){return `data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})}\n\n`;}
export const sseDone='data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
export async function readUntil(response:Response,test:(e:StreamEvent)=>boolean){
 const reader=response.body!.getReader(),decoder=new TextDecoder();let pending='';const seen:StreamEvent[]=[];
 while(true){const {value,done}=await reader.read();if(done)throw new Error('Stream ended before expected event');pending+=decoder.decode(value,{stream:true});let n:number;
  while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);if(!line.trim())continue;const event=StreamEventSchema.parse(JSON.parse(line));seen.push(event);if(test(event))return {reader,seen,pending,decoder};}
 }
}
export async function generationPost(h:Awaited<ReturnType<typeof generationHarness>>,path:string,input:unknown,signal?:AbortSignal){
 let address=h.app.server.address();if(!address){await h.app.listen({host:'127.0.0.1',port:0});address=h.app.server.address();}
 if(!address||typeof address==='string')throw new Error('Fixture missing address');
 return fetch(`http://127.0.0.1:${String(address.port)}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),...(signal?{signal}:{})});
}
export async function remaining(cursor:Awaited<ReturnType<typeof readUntil>>){
 let raw=cursor.pending;
 for(;;){const {value,done}=await cursor.reader.read();if(done)break;raw+=cursor.decoder.decode(value,{stream:true});}
 raw+=cursor.decoder.decode();cursor.reader.releaseLock();return [...cursor.seen,...(raw.trim()?events(raw):[])];
}
