#!/usr/bin/env python3
"""Execute pinned upstream's two original relationship rebuild-weight AST assignments.
MIT source attribution: third_party/LightRAG/LICENSE. Validation only, no Python runtime.
"""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys
root=Path(__file__).resolve().parents[2]
upstream=Path(sys.argv[1])
sha=subprocess.check_output(['git','-C',str(upstream),'rev-parse','HEAD'],text=True).strip()
assert sha=='aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a'
source=(upstream/'lightrag/operate.py').read_text()
tree=ast.parse(source)
statements=[n for n in ast.walk(tree) if isinstance(n,ast.Assign) and n.lineno in [2182,2201]]
assert len(statements)==2
cases=[{'weights':[3], 'sources':['B']},{'weights':[0.2], 'sources':['B']},{'weights':[0.2,3], 'sources':['B','C']},{'weights':[2,3], 'sources':['B','C']}]
for case in cases:
    scope={'weights':case['weights'],'limited_chunk_ids':case['sources'],'current_relationship':{'weight':99}}
    exec(compile(ast.Module(body=sorted(statements,key=lambda n:n.lineno),type_ignores=[]),'<upstream-rebuild-weight>','exec'),scope)
    case['expectedWeight']=scope['weight']
output={'upstream':sha,'sourceHash':hashlib.sha256(source.encode()).hexdigest(),'scope':'G02 non-degraded rebuild weight from surviving evidence, not full G02 acceptance','cases':cases}
(root/'tests/fixtures/graph/s07-python-reference.json').write_text(json.dumps(output,indent=2)+'\n')
print('Pinned relationship rebuild weight reference: four cases recorded.')
