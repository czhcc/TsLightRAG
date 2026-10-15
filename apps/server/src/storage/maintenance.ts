import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { repositoryRoot } from '../paths.js';
import { inspectStorage, recoverStorage } from './recovery.js';

try {
  const [operation, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, strict: true, options: {
    'data-dir': { type: 'string', default: './data' }, generation: { type: 'string' },
    'confirm-data-loss': { type: 'boolean', default: false },
  } });
  const root = resolve(repositoryRoot, values['data-dir']);
  const result = operation === 'inspect'
    ? await inspectStorage(root, values.generation)
    : operation === 'recover' && values.generation
      ? await recoverStorage(root, values.generation, values['confirm-data-loss'])
      : (() => { throw new Error('Use inspect or recover --generation <id> --confirm-data-loss'); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Storage maintenance failed'}\n`);
  process.exitCode = 1;
}
