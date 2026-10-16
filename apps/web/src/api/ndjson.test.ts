import {expect,it} from 'vitest';
import {readNdjson} from './ndjson.js';
import type {StreamEvent} from '@tslightrag/contracts';
const meta={type:'meta',requestId:'q1',mode:'mix'},refs={type:'references',references:[]},done={type:'done',finishReason:'stop',warnings:[]};
function stream(rows:unknown[],end='\n'){
 const bytes=new TextEncoder().encode(rows.map(r=>JSON.stringify(r)).join('\n')+end);let i=0;
 return new Response(new ReadableStream({pull(controller){if(i>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(i,i+1));i++;}}));
}
it('incrementally decodes split Unicode and validates the ordered terminal protocol',async()=>{
 const seen:StreamEvent[]=[];await readNdjson(stream([meta,refs,{type:'delta',text:'中文 🧮'},done]),e=>{seen.push(e);});expect(seen.map(e=>e.type)).toEqual(['meta','references','delta','done']);expect(seen[2]).toEqual({type:'delta',text:'中文 🧮'});
});
for(const rows of [[meta,refs,{type:'delta',text:'partial'}],[meta,refs,done,done],[meta,{type:'delta',text:'early'}],[meta,refs,{type:'unknown'}]])it(`rejects missing/reordered/duplicate terminal records ${JSON.stringify(rows).slice(0,60)}`,async()=>{
 await expect(readNdjson(stream(rows),()=>{})).rejects.toThrow();
});
it('does not promote an unterminated final line to success and accepts error/cancelled terminals',async()=>{
 await expect(readNdjson(stream([meta,refs,done],''),()=>{})).rejects.toThrow('不完整');
 await expect(readNdjson(stream([meta,{type:'cancelled'}]),()=>{})).resolves.toBeUndefined();
 await expect(readNdjson(stream([{type:'error',error:{code:'MODEL_TIMEOUT',message:'timeout',requestId:'q1'}}]),()=>{})).resolves.toBeUndefined();
});
