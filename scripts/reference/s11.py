#!/usr/bin/env python3
"""Execute complete pinned extraction/merge/summary/rebuild functions against in-memory ports.
Validation only. Original functions are compiled unchanged, never replaced with TS-derived
algorithms. SHA and source/function hashes accompany the results. LightRAG MIT attribution:
third_party/LightRAG/LICENSE. See scripts/reference/requirements.txt for validation tools.
"""
import ast
import asyncio
import base64
import collections
import copy
import dataclasses
import hashlib
import html
import inspect
import itertools
import json
import logging
import math
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time
import types
from types import SimpleNamespace
import typing
import unicodedata
from functools import partial

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '.tools/reference-python'))
import json_repair
import tiktoken

PIN = 'aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a'
upstream = Path(sys.argv[1]).resolve()
assert subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], text=True).strip() == PIN
inputs_path = ROOT / 'tests/fixtures/graph/s11-input.json'
inputs = json.loads(inputs_path.read_text())
module = types.ModuleType('pinned_reference')
sys.modules[module.__name__] = module
ns = module.__dict__
ns.update({key:value for key,value in vars(typing).items() if not key.startswith('__')})
ns.update(asyncio=asyncio, json=json, json_repair=json_repair, re=re, html=html, time=time,
          logger=logging.getLogger('reference'), logging=logging, Counter=collections.Counter,
          defaultdict=collections.defaultdict, partial=partial, dataclass=dataclasses.dataclass,
          field=dataclasses.field, inspect=inspect, os=os, hashlib=hashlib, md5=hashlib.md5,
          Path=Path, math=math, itertools=itertools, unicodedata=unicodedata)
ns.update({k:v for k,v in runpy.run_path(str(upstream/'lightrag/constants.py')).items() if not k.startswith('__')})

# Fixed model/storage/lock/log ports. No extraction, aggregation, summary selection or rebuild
# algorithm is implemented here. Upstream's cache wrapper is a model boundary; its full rebuild
# cache-reader/parser functions execute below against the actual synthetic cache rows.
class StatusLogger:
    def __init__(self, *_): pass
    def log(self, *_): pass
class PipelineCancelledException(Exception): pass
class IndexFlushError(Exception): pass
async def model_port(prompt, model, **kwargs):
    return await model(prompt, **kwargs), 1
async def tokenizer_executor(fn, *args, **kwargs): return fn(*args, **kwargs)
async def disabled_cache(*args, **kwargs): return None
ns.update(PipelineStatusLogger=StatusLogger, PipelineCancelledException=PipelineCancelledException,
          IndexFlushError=IndexFlushError, use_llm_func_with_cache=model_port,
          get_llm_cache_identity=lambda *a: 'fixture', get_storage_keyed_lock=lambda *a, **k: asyncio.Lock(),
          run_in_tokenizer_executor=tokenizer_executor, handle_cache=disabled_cache, QueryResult=lambda **kw: SimpleNamespace(**kw))

# Load the original definitions and required module constants from pinned files. Future
# annotations avoids importing the application's production storage framework. AST bodies,
# including comparisons, control flow and decorators, remain unchanged.
index = {}; assignment = {}; manifest = {}; loaded = set(); loading = set()
for filename in ['utils.py', 'chunk_schema.py', 'prompt.py', 'operate.py']:
    source = (upstream/'lightrag'/filename).read_text()
    manifest[filename] = {'sha256':hashlib.sha256(source.encode()).hexdigest(), 'loadedFunctions':{}}
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            index[node.name] = (filename, node, source)
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name): assignment[target.id] = (filename, node)

def load(name):
    if name in ns or name in loading: return
    loading.add(name)
    if name in index:
        filename, node, source = index[name]
        for dependency in {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}:
            if dependency != name: load(dependency)
        code = ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0), node],type_ignores=[])
        exec(compile(ast.fix_missing_locations(code), str(upstream/'lightrag'/filename), 'exec'), ns)
        manifest[filename]['loadedFunctions'][name] = hashlib.sha256(ast.get_source_segment(source,node).encode()).hexdigest()
        loaded.add(name)
    elif name in assignment:
        filename, node = assignment[name]
        for dependency in {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}: load(dependency)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),str(upstream/'lightrag'/filename),'exec'),ns)
    loading.discard(name)

# Prompt values are original literal assignments, including subscript targets.
ns['PROMPTS'] = {}
for node in ast.parse((upstream/'lightrag/prompt.py').read_text()).body:
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) and target.value.id == 'PROMPTS':
                ns['PROMPTS'][ast.literal_eval(target.slice)] = ast.literal_eval(node.value)

# Use independent Python BPE with the same locked cl100k_base vocabulary data as JS;
# no online vocabulary fetch, no token counts or expected outputs from the TS implementation.
ranks_path = ROOT/'node_modules/js-tiktoken/dist/ranks/cl100k_base.cjs'
ranks = json.loads(ranks_path.read_text().removeprefix('module.exports = ').rstrip().rstrip(';'))
mergeable = {}
for line in ranks['bpe_ranks'].splitlines():
    _, offset, *tokens = line.split(' ')
    mergeable.update({base64.b64decode(token):int(offset)+i for i, token in enumerate(tokens)})
encoding = tiktoken.Encoding(name='shared-cl100k-base',pat_str=ranks['pat_str'],mergeable_ranks=mergeable,special_tokens=ranks['special_tokens'])
load('Tokenizer')
def Tokenizer(): return ns['Tokenizer'](model_name='shared-cl100k-base', tokenizer=encoding)
for name in ['extract_entities','_merge_nodes_then_upsert','_merge_edges_then_upsert','_handle_entity_relation_summary','rebuild_knowledge_from_chunks','naive_query']:
    load(name)

class KV:
    def __init__(self, data=None): self.data=copy.deepcopy(data or {})
    async def get_by_id(self, key): return copy.deepcopy(self.data.get(key))
    async def get_by_ids(self, keys): return [await self.get_by_id(key) for key in keys]
    async def upsert(self, rows): self.data.update(copy.deepcopy(rows))
class Graph:
    def __init__(self): self.nodes={};self.edges={}
    async def get_node(self, key): return copy.deepcopy(self.nodes.get(key))
    async def has_node(self, key): return key in self.nodes
    async def upsert_node(self, key, node_data): self.nodes[key]=copy.deepcopy(node_data)
    async def get_edge(self, a, b): return copy.deepcopy(self.edges.get(tuple(sorted([a,b]))))
    async def has_edge(self, a, b): return tuple(sorted([a,b])) in self.edges
    async def upsert_edge(self, a, b, edge_data): self.edges[tuple(sorted([a,b]))]=copy.deepcopy(edge_data)
    async def get_node_edges(self, key): return [pair for pair in self.edges if key in pair]
class VDB(KV):
    async def delete(self, keys):
        for key in keys: self.data.pop(key,None)

async def summary_model(*args, **kwargs): return inputs['summaryModelOutput']
def config(model=summary_model):
    return dict(tokenizer=Tokenizer(),role_llm_funcs={'extract':model},entity_extract_max_gleaning=1,
                entity_extraction_use_json=True,entity_extract_max_records=100,entity_extract_max_entities=100,
                addon_params={'language':'Chinese'},llm_model_max_async=1,
                summary_context_size=8192,summary_max_tokens=500,force_llm_summary_on_merge=8,
                summary_length_recommended=500,source_ids_limit_method='KEEP',max_source_ids_per_entity=10000,
                max_source_ids_per_relation=10000,embedding_token_limit=None)

def normalize_extraction(result):
    nodes, edges = result
    return {'entities': sorted([{'name':name,'type':values[0]['entity_type'],'description':values[0]['description']} for name,values in nodes.items()],key=lambda v:v['name']),
            'relationships': sorted([{'source':min(pair),'target':max(pair),'description':values[0]['description'],'keywords':sorted(x.strip() for x in values[0]['keywords'].split(',')),'strength':values[0]['weight']} for pair,values in edges.items()],key=lambda v:(v['source'],v['target']))}
def normalize_graph(graph):
    return {'nodes': sorted([{'name':name,'type':row['entity_type'],'descriptions':sorted(row['description'].split('<SEP>')),'sources':sorted(row['source_id'].split('<SEP>'))} for name,row in graph.nodes.items()],key=lambda r:r['name']),
            'edges': sorted([{'source':a,'target':b,'descriptions':sorted(row['description'].split('<SEP>')),'sources':sorted(row['source_id'].split('<SEP>')),'keywords':sorted(x.strip() for x in row['keywords'].split(',')),'weight':row['weight']} for (a,b),row in graph.edges.items()],key=lambda r:(r['source'],r['target']))}

executed=set()
def trace(frame,event,arg):
    if event=='call' and frame.f_code.co_filename.startswith(str(upstream/'lightrag')):
        executed.add((Path(frame.f_code.co_filename).name,frame.f_code.co_name))
sys.setprofile(trace)
async def main():
    extracted=[]
    for case in inputs['extraction']:
        calls=[]
        async def model(prompt, **kwargs):
            calls.append({'history':bool(kwargs.get('history_messages'))})
            return json.dumps(case['rounds'][len(calls)-1])
        result=await ns['extract_entities']({'A':{'content':'Alpha and Beta evidence','file_path':'A.txt'}},config(model))
        extracted.append({'name':case['name'],'result':normalize_extraction(result[0]),'modelCalls':len(calls)})
    summaries=[]
    for case in inputs['summaries']:
        calls=[]
        async def model(prompt, **kwargs): calls.append(prompt); return inputs['summaryModelOutput']
        description, used=await ns['_handle_entity_relation_summary']('Entity','Alpha',case['descriptions'],'<SEP>',config(model))
        summaries.append({'name':case['name'],'description':description,'modelCalls':len(calls),'usedModel':used,'inputTokens':sum(len(Tokenizer().encode(s)) for s in case['descriptions'])})
    graph=Graph(); entities=VDB(); relations=VDB(); entity_chunks=KV(); relation_chunks=KV();chunks=KV();cache=KV()
    for i,doc in enumerate(inputs['documents']):
        chunk=doc['chunkId']; raw=json.dumps(doc['raw'])
        nodes,edges=await ns['_process_json_extraction_result'](raw,chunk,i+1,chunk+'.txt')
        for name,values in nodes.items(): await ns['_merge_nodes_then_upsert'](name,values,graph,entities,config(),entity_chunks_storage=entity_chunks)
        for (a,b),values in edges.items(): await ns['_merge_edges_then_upsert'](a,b,values,graph,relations,entities,config(),relation_chunks_storage=relation_chunks,entity_chunks_storage=entity_chunks)
        await chunks.upsert({chunk:{'file_path':chunk+'.txt','llm_cache_list':['cache-'+chunk]}})
        await cache.upsert({'cache-'+chunk:{'cache_type':'extract','chunk_id':chunk,'return':raw,'create_time':i+1}})
    merged=normalize_graph(graph)
    # Repeat an existing source; weight and source sets must remain unchanged.
    retry=inputs['documents'][0]
    _,edges=await ns['_process_json_extraction_result'](json.dumps(retry['raw']),'A',1,'A.txt')
    for (a,b),values in edges.items(): await ns['_merge_edges_then_upsert'](a,b,values,graph,relations,entities,config(),relation_chunks_storage=relation_chunks,entity_chunks_storage=entity_chunks)
    assert normalize_graph(graph)==merged
    deletion=[]
    for removed in ['A','B']:
        g=copy.deepcopy(graph);ev=copy.deepcopy(entities);rv=copy.deepcopy(relations);ec=copy.deepcopy(entity_chunks);rc=copy.deepcopy(relation_chunks)
        survivors={name:[s for s in row['source_id'].split('<SEP>') if s!=removed] for name,row in g.nodes.items()}
        pairs={pair:[s for s in row['source_id'].split('<SEP>') if s!=removed] for pair,row in g.edges.items()}
        # Whole-document ownership subtraction is an explicit storage input to the upstream
        # rebuild entrypoint. The complete rebuild/cache read/parsing/aggregation runs below.
        for name,ids in survivors.items():
            if not ids: g.nodes.pop(name)
        for pair,ids in pairs.items():
            if not ids: g.edges.pop(pair)
        report=await ns['rebuild_knowledge_from_chunks']({n:ids for n,ids in survivors.items() if ids},{p:ids for p,ids in pairs.items() if ids},g,ev,rv,chunks,cache,config(),entity_chunks_storage=ec,relation_chunks_storage=rc,rebuild_policy='rollback')
        assert not report.has_warnings
        deletion.append({'removed':removed,'graph':normalize_graph(g),'entityVectorSources':sorted([sorted(r['source_id'].split('<SEP>')) for r in ev.data.values() if r.get('entity_name') in g.nodes]),'relationVectorSources':sorted([sorted(r['source_id'].split('<SEP>')) for r in rv.data.values() if (r.get('src_id'),r.get('tgt_id')) in g.edges])})
    naive=[]
    for no_evidence in [False, True]:
        calls=[]
        async def model(query, **kwargs):
            calls.append({'query':query,'system':kwargs['system_prompt'],'history':kwargs['history_messages']})
            return 'Alpha source evidence [1].'
        class Chunks:
            cosine_better_than_threshold=0.2
            async def query(self,*args,**kwargs): return [] if no_evidence else [{'id':inputs['naiveChunk']['id'],'content':inputs['naiveChunk']['content'],'file_path':inputs['naiveChunk']['fileName']}]
        param=SimpleNamespace(mode='naive',top_k=40,chunk_top_k=20,max_entity_tokens=6000,max_relation_tokens=8000,max_total_tokens=16000,enable_rerank=False,response_type='Multiple Paragraphs',user_prompt=None,disable_user_prompt_prefix=False,conversation_history=[{'role':'user','content':'Earlier question'}],stream=False,only_need_context=False,only_need_prompt=False)
        cfg=config();cfg['role_llm_funcs']['query']=model
        result=await ns['naive_query']('What is Alpha?',Chunks(),param,cfg)
        naive.append({'empty':no_evidence,'query':'What is Alpha?','history':param.conversation_history,'calls':calls,'raw':result.raw_data if result else None,'response':result.content if result else None})
    output={'upstream':PIN,'inputSha256':hashlib.sha256(inputs_path.read_bytes()).hexdigest(),'tokenVocabularySha256':hashlib.sha256(ranks_path.read_bytes()).hexdigest(),
            'manifest':manifest,'executedFunctions':sorted([file+'::'+name for file,name in executed if not name.startswith('<')]),
            'ports':['deterministic LLM responses and cache-wrapper transport','in-memory graph/KV/vector storage','asyncio storage locks and status logging','independent tiktoken BPE using locked common vocabulary'],
            'scope':'full G01 extraction/gleaning, G02 node/edge merge and summary, G11 rebuild entrypoint/cache parsing and surviving aggregation; source subtraction is a storage fixture input',
            'naive':naive,'extraction':extracted,'summaries':summaries,'merged':merged,'deletion':deletion}
    (ROOT/'tests/fixtures/graph/s11-python-reference.json').write_text(json.dumps(output,ensure_ascii=False,indent=2,sort_keys=True)+'\n')
    print('Executed full pinned extraction, merge, summary and rebuild functions; results recorded.')
asyncio.run(main())
