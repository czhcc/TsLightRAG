#!/usr/bin/env python3
"""Execute complete pinned LightRAG retrieval functions with deterministic in-memory ports.
Python is validation-only. No retrieval algorithm is reimplemented here. MIT attribution:
third_party/LightRAG/LICENSE. Requires numpy (reference checkout's dependency).
"""
import ast, asyncio, hashlib, json, logging, re, subprocess, sys, time
from pathlib import Path
from types import SimpleNamespace
from functools import partial
import numpy as np
root=Path(__file__).resolve().parents[2]
upstream=Path(sys.argv[1]);sha=subprocess.check_output(['git','-C',str(upstream),'rev-parse','HEAD'],text=True).strip()
assert sha=='aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a'
ns=dict(asyncio=asyncio,json=json,logger=logging.getLogger('reference'),np=np,re=re,time=time,partial=partial,
 GRAPH_FIELD_SEP='<SEP>',DEFAULT_RELATED_CHUNK_NUMBER=5,DEFAULT_KG_CHUNK_PICK_METHOD='VECTOR',DEFAULT_QUERY_PRIORITY=5,DEFAULT_MAX_ENTITY_TOKENS=6000,DEFAULT_MAX_RELATION_TOKENS=8000)
names={
 'operate.py':['kg_query','_normalize_keyword_list','_perform_kg_search','_get_vector_context','_get_node_data','_find_most_related_edges_from_entities','_get_edge_data','_find_most_related_entities_from_relationships','_vector_chunk_quota','_find_related_text_unit_from_entities','_find_related_text_unit_from_relations','_merge_all_chunks','_apply_token_truncation'],
 'utils.py':['split_string_by_multi_markers','cosine_similarity','pick_by_weighted_polling','pick_by_vector_similarity','truncate_list_by_token_size','atruncate_list_by_token_size','_rendered_prefix_item_count','process_chunks_unified','_truncate_chunks_for_unified_context','generate_reference_list_from_chunks','render_chunks_context_text']}
manifest={}
for filename,selected in names.items():
 source=(upstream/'lightrag'/filename).read_text();tree=ast.parse(source)
 functions=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in selected and not n.decorator_list]
 assert len(functions)==len(selected),(filename,[n.name for n in functions])
 for n in functions:n.decorator_list=[]
 module=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*functions],type_ignores=[])
 exec(compile(ast.fix_missing_locations(module),filename,'exec'),ns)
 manifest[filename]={'sha256':hashlib.sha256(source.encode()).hexdigest(),'executedFunctions':selected}
class TokenBudgetError(Exception):pass
class CharTokenizer:
 def encode(self,text):return list(text)
 def truncate_by_token_limit(self,text,limit):return SimpleNamespace(end=min(len(text),limit))
async def executor(fn,*a,**kw):return fn(*a,**kw)
ns.update(run_in_tokenizer_executor=executor,TokenBudgetError=TokenBudgetError)
# Storage/model adapters provide data and vectors only; ranking is upstream code above.
nodes={name:dict(entity_type='Concept',description=name+' evidence',source_id='<SEP>'.join(ids)) for name,ids in {'A':['z','a','shared'],'B':['shared','b','c','d'],'C':['a','e'],'D':['f']}.items()}
edges={('A','B'):dict(weight=2,description='AB',source_id='shared<SEP>g'),('A','C'):dict(weight=1,description='AC',source_id='a<SEP>h'),('B','D'):dict(weight=9,description='BD',source_id='b<SEP>i'),('D','D'):dict(weight=1,description='DD',source_id='j')}
chunks={i:dict(content=i+' document evidence',file_path='doc-'+str(k%2)) for k,i in enumerate(['z','a','shared','b','c','d','e','f','g','h','i','j','outside'])}
vectors={i:[1,0] if i in ['z','a','outside'] else [0.6,0.8] for i in chunks}
class Graph:
 def adjacent(self,n):return [p for p in edges if n in p]
 def degree(self,n):return sum(2 if a==b==n else 1 for a,b in self.adjacent(n))
 async def get_nodes_batch(self,ids):return {i:dict(nodes[i]) for i in ids if i in nodes}
 async def node_degrees_batch(self,ids):return {i:self.degree(i) for i in ids}
 async def get_nodes_edges_batch(self,ids):return {i:self.adjacent(i) for i in ids}
 async def get_edges_batch(self,pairs):return {(p['src'],p['tgt']):dict(edges[tuple(sorted([p['src'],p['tgt']]))]) for p in pairs}
 async def edge_degrees_batch(self,pairs):return {p:self.degree(p[0])+self.degree(p[1]) for p in pairs}
class VDB:
 cosine_better_than_threshold=0.2
 def __init__(self,kind,missing=False):self.kind=kind;self.missing=missing
 async def query(self,query,top_k,query_embedding=None):
  if self.kind=='entities':return [{'entity_name':i} for i in ['C','A','B']][:top_k]
  if self.kind=='relations':return [{'src_id':a,'tgt_id':b} for a,b in [('D','D'),('A','C'),('A','B')]][:top_k]
  return [{'id':i,**chunks[i]} for i in ['outside','z','j']][:top_k]
 async def get_vectors_by_ids(self,ids):return {i:vectors[i] for i in ids if i in vectors and not(self.missing and i=='z')}
async def embed(texts,**kw):return [[1,0] for _ in texts]
class KV:
 def __init__(self,method,r):self.global_config={'kg_chunk_pick_method':method,'related_chunk_number':r};self.embedding_func=embed
 async def get_by_ids(self,ids):return [dict(chunks[i]) if i in chunks else None for i in ids]
async def main():
 cases=[]
 for mode in ['local','global','hybrid','mix']:
  for method in ['VECTOR','WEIGHT']:
   for r in [0,1,2,5]:
    param=SimpleNamespace(mode=mode,top_k=3,chunk_top_k=3,max_entity_tokens=6000,max_relation_tokens=8000)
    kv=KV(method,r);vdb=VDB('chunks');g=Graph()
    raw=await ns['_perform_kg_search']('question','low','high',g,VDB('entities'),VDB('relations'),kv,param,vdb)
    trunc=await ns['_apply_token_truncation'](raw,param,{'tokenizer':CharTokenizer()})
    en=trunc['filtered_entities'];rel=trunc['filtered_relations']
    ec=await ns['_find_related_text_unit_from_entities'](en,param,kv,g,'question',vdb,query_embedding=[1,0])
    rc=await ns['_find_related_text_unit_from_relations'](rel,param,kv,ec,'question',vdb,query_embedding=[1,0])
    merged=await ns['_merge_all_chunks'](en,rel,raw['vector_chunks'],'question',g,kv,param,vdb,query_embedding=[1,0])
    pair=lambda e:list(e['src_tgt']) if 'src_tgt' in e else [e['src_id'],e['tgt_id']]
    cases.append(dict(mode=mode,method=method,related=r,entities=[n['entity_name'] for n in en],relations=[pair(e) for e in rel],entityChunks=[c['chunk_id'] for c in ec],relationChunks=[c['chunk_id'] for c in rc],merged=[c['chunk_id'] for c in merged]))
 # G03 executes full kg_query through its debug-context return, substituting only keyword/model/context ports.
 async def keywords(*args):return [],[]
 async def context(query,ll,hl,*args,**kw):return SimpleNamespace(context=json.dumps({'low':ll,'high':hl}),raw_data={})
 ns.update(get_keywords_from_query=keywords,_build_query_context=context,get_llm_cache_identity=lambda *a:'fixture',QueryResult=lambda **kw:SimpleNamespace(**kw),PROMPTS={'fail_response':'no-result'})
 fallback=[]
 for q in ['short','x'*50,'🙂'*49,'🙂'*50]:
  result=await ns['kg_query'](q,Graph(),VDB('entities'),VDB('relations'),KV('VECTOR',5),SimpleNamespace(mode='mix',only_need_context=True,only_need_prompt=False),{'role_llm_funcs':{'query':lambda:None}})
  fallback.append({'query':q,'content':result.content})
 selection=[]
 for missing in [False,True]:
  for method in ['VECTOR','WEIGHT']:
   kv=KV(method,2);vdb=VDB('chunks',missing)
   en=[{'entity_name':n,**nodes[n]} for n in ['A','B','C']]
   chosen=await ns['_find_related_text_unit_from_entities'](en,None,kv,Graph(),'q',vdb,query_embedding=[1,0])
   selection.append({'missing':missing,'method':method,'expected':[c['chunk_id'] for c in chosen]})
 groups=[['a'],['b','c','d','e','f','g'],['h','i','j','k','l','m'],['n','o']]
 polling=[{'groups':groups,'related':r,'expected':ns['pick_by_weighted_polling']([{'sorted_chunks':g} for g in groups],r)} for r in [0,1,2,4,6]]
 truncation=[]
 raw=await ns['_perform_kg_search']('question','low','high',Graph(),VDB('entities'),VDB('relations'),KV('VECTOR',1),SimpleNamespace(mode='hybrid',top_k=3,chunk_top_k=3),VDB('chunks'))
 for size in [0,1,80,160,10000]:
  t=await ns['_apply_token_truncation'](raw,SimpleNamespace(max_entity_tokens=size,max_relation_tokens=size),{'tokenizer':CharTokenizer()})
  truncation.append({'limit':size,'entities':[n['entity_name'] for n in t['filtered_entities']],'relations':[pair(e) for e in t['filtered_relations']]})
 # Execute the complete upstream post-retrieval rerank -> topK -> exact-render truncation pipeline.
 async def rerank(**kw):return [{**c,'rerank_score':0.9} for c in reversed(kw['retrieved_docs'])]
 ns['apply_rerank_if_enabled']=rerank
 processing=[]
 for limit in [0,50,100,10000]:
  processed=await ns['process_chunks_unified']('question',[{'chunk_id':i,**chunks[i]} for i in ['z','a']],SimpleNamespace(enable_rerank=True,chunk_top_k=2),{'tokenizer':CharTokenizer()},chunk_token_limit=limit)
  refs,linked=ns['generate_reference_list_from_chunks'](processed)
  processing.append({'limit':limit,'chunks':[c['chunk_id'] for c in processed],'references':refs,'linked':linked})
 normalized=[{'input':v,'expected':ns['_normalize_keyword_list'](v,'fixture')} for v in [None,'Alpha; Beta, Gamma\nDelta',['a,b',' c ',42,''],{'bad':True}]]
 # Preserve exact original VDB construction expressions as independent identity/content evidence.
 op=ast.parse((upstream/'lightrag/operate.py').read_text())
 payload={}
 for label,line,values in [('entity',2746,{'entity_name':'Alpha','description':'Evidence'}),('relation',3394,{'keywords':'research, collaboration','vdb_src_id':'Alpha','vdb_tgt_id':'Beta','description':'Evidence'})]:
  expression=next(n for n in ast.walk(op) if isinstance(n,ast.JoinedStr) and n.lineno==line)
  payload[label]=eval(compile(ast.Expression(expression),'<original-vdb-content>','eval'),values)
 payload['chunk']=chunks['z']['content']
 citations=[]
 for ids in [['a','z','c'],['z','a'],[]]:
  refs,linked=ns['generate_reference_list_from_chunks']([{'chunk_id':i,**chunks[i]} for i in ids])
  citations.append({'chunks':linked,'references':refs})
 output={'upstream':sha,'manifest':manifest,'ports':'deterministic graph/KV/vector/embedding and one-codepoint tokenizer; no replacement ranking implementations','nodes':nodes,'edges':[{'source':a,'target':b,**e} for (a,b),e in edges.items()],'vectors':vectors,'cases':cases,'fallback':fallback,'selection':selection,'polling':polling,'truncation':truncation,'processing':processing,'normalized':normalized,'vectorContent':payload,'citations':citations}
 (root/'tests/fixtures/graph/s08-python-reference.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
 print(f'{len(cases)} upstream retrieval cases, fallback/selection/polling/truncation recorded.')
asyncio.run(main())
