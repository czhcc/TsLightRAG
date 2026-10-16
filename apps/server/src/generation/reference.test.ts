import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {QuerySchema} from '@tslightrag/contracts';
import {generationMessages} from '../retrieval/context.js';
const reference=JSON.parse(readFileSync(new URL('../../../../tests/fixtures/graph/s09-python-reference.json',import.meta.url),'utf8')) as {cases:{query:{user_prompt:string|null;conversation_history:{role:'user'|'assistant';content:string}[];only_need_context:boolean;only_need_prompt:boolean};context:string;empty:boolean;calls:unknown[];messages:{role:string;content:string}[];response:string|null}[]};
for(const [i,c]of reference.cases.entries())it(`matches pinned kg_query prompt/message handoff case ${String(i)}`,()=>{
 if(c.calls.length){expect(generationMessages(QuerySchema.parse({query:'How does Alpha cooperate?',mode:'hybrid',...(c.query.user_prompt!==null?{userPrompt:c.query.user_prompt}:{}),conversationHistory:c.query.conversation_history}),c.context)).toEqual(c.messages);}
 else if(c.empty)expect(c.response).toBeNull();else expect(c.query.only_need_context||c.query.only_need_prompt).toBe(true);
});
