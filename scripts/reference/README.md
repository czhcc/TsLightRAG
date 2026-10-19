# Pinned upstream reference validation

These Python programs run only during validation. The application, its parsers and model
clients remain TypeScript and do not launch Python. All source-derived functions and prompt
values use HKUDS/LightRAG's MIT license at `third_party/LightRAG/LICENSE`.

From the repository root, use the existing `.tools/LightRAG-upstream` reference checkout, or
prepare it once (do not overwrite another checkout or create a Git worktree):

```bash
git clone --no-checkout https://github.com/HKUDS/LightRAG.git .tools/LightRAG-upstream
git -C .tools/LightRAG-upstream checkout --detach aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a
python3 -m pip install --target .tools/reference-python -r scripts/reference/requirements.txt
npm run test:reference
```

The runner checks the full HEAD SHA, runs S06/S07/S08/S09/S11 generators and fails if any
checked-in reference fixture changes. Pass another already pinned source checkout as
`npm run test:reference -- /absolute/reference/path`. Python 3.12 was used for S11. Pinned
reference dependencies live in an ignored directory; no key or model provider is needed.

S06/S07 retain their historical narrow helper evidence. S08 executes complete retrieval,
selection, ranking, merging and truncation functions; S09 executes complete `kg_query`
generation and instruction/history handoff. S11 adds complete `extract_entities`, node/edge
merge, map/reduce summary, `rebuild_knowledge_from_chunks` (including its cache readers and
parsers), and `naive_query`. S11 records source/function/input/vocabulary hashes and actually
called function names. It compiles original AST definitions unchanged. Deterministic
LLM responses, disabled cache transport, in-memory storage, locks and status logging are
ports. For rebuild, the deleted document's remaining source set is an explicit storage
fixture input; this does not execute the whole upstream server or its deletion router.

S11 uses independent Python tiktoken BPE with cl100k_base vocabulary data from the locked
`js-tiktoken@1.0.21` package. It never fetches a vocabulary at runtime and does not take
expected token counts, rankings or graph outputs from the TS implementation. Source rows
are standard JSON strength=1; existing separate tests cover the target's explicit strength
extension. Names/IDs and description/source sets are normalized for storage mapping;
retrieval candidate and chunk order comparisons remain exact. See `docs/VALIDATION_REPORT.md`
for the accepted differences and per-G01–G12 evidence.
