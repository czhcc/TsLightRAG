import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const checkout = resolve(root, process.argv[2] ?? '.tools/LightRAG-upstream');
const pin = 'aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a';
const head = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.status !== 0 || head.stdout.trim() !== pin) {
  throw new Error(`Reference checkout must be at ${pin}; see scripts/reference/README.md`);
}
for (const stage of ['s06', 's07', 's08', 's09', 's11']) {
  const fixture = resolve(root, `tests/fixtures/graph/${stage}-python-reference.json`);
  const before = readFileSync(fixture);
  const result = spawnSync('python3', [`scripts/reference/${stage}.py`, checkout], {
    cwd: root, stdio: 'inherit', env: { ...process.env,
      PYTHONPATH: [resolve(root, '.tools/reference-python'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!before.equals(readFileSync(fixture))) throw new Error(`${stage} reference differs from its checked-in fixture; review the exact source/input/output change.`);
}
console.log('All five pinned-source reference generators reproduced their checked-in fixtures exactly.');
