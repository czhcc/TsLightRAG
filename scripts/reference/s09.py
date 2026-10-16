#!/usr/bin/env python3
"""Validation-only execution of pinned complete kg_query generation and instruction-slot functions.
Retrieval and disabled cache are ports; G03-G10 retrieval is independently executed in s08.py.
MIT source attribution: third_party/LightRAG/LICENSE. Standard library only.
"""
import ast, asyncio, hashlib, json, logging, subprocess, sys
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from typing import NamedTuple
root=Path(__file__).resolve().parents[2];upstream=Path(sys.argv[1])
sha=subprocess.check_output(['git','-C',str(upstream),'rev-parse','HEAD'],text=True).strip()
assert sha=='aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a'
ns={'json':json,'partial':partial,'logger':logging.getLogger('reference'),'logging':logging,'md5':hashlib.md5,'NamedTuple':NamedTuple,'DEFAULT_QUERY_PRIORITY':5,'DEFAULT_RELATED_CHUNK_NUMBER':5,'DEFAULT_KG_CHUNK_PICK_METHOD':'VECTOR','_ANSWER_CACHE_POLICY_VERSION':'query-answer-cache-v2','QueryResult':lambda **kw:SimpleNamespace(**kw)}
manifest={}
for file,names in {'operate.py':['kg_query','_answer_cache_kv'],'utils.py':['EffectiveUserPrompt','resolve_user_prompt','compute_args_hash','_serialize_cache_variant','serialize_llm_cache_identity']}.items():
 source=(upstream/'lightrag'/file).read_text();tree=ast.parse(source)
 nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) and n.name in names and not n.decorator_list]
 assert len(nodes)==len(names)
 module=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*nodes],type_ignores=[])
 exec(compile(ast.fix_missing_locations(module),file,'exec'),ns)
 manifest[file]={'sha256':hashlib.sha256(source.encode()).hexdigest(),'executedFunctions':names}
prompt_source=(upstream/'lightrag/prompt.py').read_text();prompts={}
for n in ast.parse(prompt_source).body:
 if isinstance(n,ast.Assign):
  for target in n.targets:
   if isinstance(target,ast.Subscript) and isinstance(target.value,ast.Name) and target.value.id=='PROMPTS':
    try:prompts[ast.literal_eval(target.slice)]=ast.literal_eval(n.value)
    except (ValueError,TypeError):pass
ns['PROMPTS']=prompts
async def keywords(*args):return ['theme'],['Alpha']
async def no_cache(*args,**kw):return None
ns.update(get_keywords_from_query=keywords,handle_cache=no_cache,get_llm_cache_identity=lambda *args:'fixture')
async def main():
 cases=[]
 for instructions,history,debug,empty in [(None,[],None,False),('使用中文。',[{'role':'user','content':'earlier'},{'role':'assistant','content':'prior'}],None,False),('保留 {query} 和 {{literal}}',[],None,False),(None,[],'context',False),(None,[],'prompt',False),(None,[],None,True)]:
  context='Entity: Alpha; Relationship: Alpha-Beta; Chunk: source evidence [1].\n[1] knowledge.txt'
  calls=[]
  async def context_port(*args,**kwargs):return None if empty else SimpleNamespace(context=context,raw_data={'references':[{'id':'1'}]})
  async def model(query,**kwargs):calls.append({'query':query,'system':kwargs['system_prompt'],'history':kwargs['history_messages'],'stream':kwargs['stream']});return 'Alpha cooperates [1].'
  ns['_build_query_context']=context_port
  param=SimpleNamespace(mode='hybrid',top_k=40,chunk_top_k=20,max_entity_tokens=6000,max_relation_tokens=8000,max_total_tokens=16000,enable_rerank=False,response_type='Multiple Paragraphs',user_prompt=instructions,disable_user_prompt_prefix=False,conversation_history=history,stream=False,only_need_context=debug=='context',only_need_prompt=debug=='prompt')
  result=await ns['kg_query']('How does Alpha cooperate?',None,None,None,None,param,{'role_llm_funcs':{'query':model},'tokenizer':object()})
  messages=[] if not calls else [{'role':'system','content':calls[0]['system']},*history,{'role':'user','content':calls[0]['query']}]
  cases.append({'query':param.__dict__,'context':context,'empty':empty,'calls':calls,'messages':messages,'response':result.content if result else None})
 output={'upstream':sha,'manifest':manifest,'promptSha256':hashlib.sha256(prompt_source.encode()).hexdigest(),'scope':'G12 final system/context/instructions/history/query handoff, debug bypass and empty retrieval; cache disabled, retrieval port separately covered by S08','cases':cases}
 (root/'tests/fixtures/graph/s09-python-reference.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
 print('Pinned full kg_query generation: six instruction/history/debug/empty cases recorded.')
asyncio.run(main())
