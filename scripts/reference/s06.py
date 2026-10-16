#!/usr/bin/env python3
"""Run selected unmodified AST helpers/weight statements from pinned upstream.
Validation only; no Python app dependency. Does not validate full G01/G02 or deletion.
Source-derived execution and generated fixture: MIT, third_party/LightRAG/LICENSE.
Usage: python3 scripts/reference/s06.py /tmp/LightRAG-reference
"""
import ast
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
upstream = Path(sys.argv[1])
sha = subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], text=True).strip()
assert sha == 'aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a'
sources = {name: (upstream / 'lightrag' / name).read_text() for name in ['utils.py', 'operate.py']}
trees = {name: ast.parse(value) for name, value in sources.items()}
namespace = {'re': re, 'html': html}
selected = []
for node in trees['utils.py'].body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ['_SURROGATE_PATTERN', '_CONTROL_CHAR_PATTERN_ALL'] for t in node.targets):
        selected.append(node)
    if isinstance(node, ast.FunctionDef) and node.name in ['sanitize_text_for_encoding', 'normalize_extracted_info', 'sanitize_and_normalize_extracted_text', 'normalize_entity_name']:
        selected.append(node)
selected += [n for n in trees['operate.py'].body if isinstance(n, ast.FunctionDef) and n.name == '_combine_descriptions_dedup']
exec(compile(ast.Module(body=selected, type_ignores=[]), '<pinned-upstream-helpers>', 'exec'), namespace)
merge_edge = next(n for n in trees['operate.py'].body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_merge_edges_then_upsert')
assignments = [n for n in ast.walk(merge_edge) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ['already_edge_source_set','weight','evidence_count'] for t in n.targets)]
# Only these four statements belong to the final source-weight branch.
assignments = sorted([n for n in assignments if n.lineno >= 2980 and n.lineno <= 3000 or any(isinstance(t, ast.Name) and t.id == 'already_edge_source_set' for t in n.targets)], key=lambda n: n.lineno)
assert len(assignments) == 4
fixture = json.loads((root / 'tests/fixtures/graph/s06-input.json').read_text())
weights = []
for case in fixture['weights']:
    values = {'already_source_ids': case['storedSources'], 'already_weights': case['storedWeights'], 'edges_data': case['incoming'], 'source_ids': case['sources'], 'RELATION_NO_EVIDENCE_SOURCE_IDS': set()}
    exec(compile(ast.Module(body=assignments, type_ignores=[]), '<pinned-upstream-weight>', 'exec'), values)
    weights.append(values['weight'])
combined, stored_count = namespace['_combine_descriptions_dedup'](fixture['descriptions']['stored'], fixture['descriptions']['incoming'])
output = {'upstream': sha, 'scope': 'G01 common name samples; G02 exact description dedup and source-weight branch only; no full gate claim',
          'sourceHashes': {n: hashlib.sha256(v.encode()).hexdigest() for n, v in sources.items()},
          'inputHash': hashlib.sha256((root / 'tests/fixtures/graph/s06-input.json').read_bytes()).hexdigest(),
          'names': [namespace['normalize_entity_name'](v) for v in fixture['names']],
          'descriptions': combined, 'storedDescriptionCount': stored_count, 'weights': weights}
(root / 'tests/fixtures/graph/s06-python-reference.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
print('Pinned Python source helpers: names, description dedup, four weight cases recorded.')
