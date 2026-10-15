import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startFakeModel } from '../helpers/fake-model.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';

it('isolates test directories and removes only owned files', async () => {
  const first = await temporaryDirectory(); const second = await temporaryDirectory();
  try {
    await writeFile(join(first.path, 'fixture.txt'), 'first');
    await writeFile(join(second.path, 'fixture.txt'), 'second');
    await first.cleanup();
    expect(await readFile(join(second.path, 'fixture.txt'), 'utf8')).toBe('second');
  } finally { await Promise.all([first.cleanup(), second.cleanup()]); }
});

it('provides input-sensitive HTTP model fixtures with recorded protocol requests', async () => {
  const model = await startFakeModel((request, response) => {
    if (request.path !== '/v1/chat/completions' || request.method !== 'POST' || request.headers.authorization !== 'Bearer fixture-only') {
      response.writeHead(400).end(); return;
    }
    const body = request.body as { model: string; messages: { content: string }[] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: `Echo: ${body.messages[0]?.content ?? ''}` } }] }));
  });
  try {
    for (const input of ['first', 'second']) {
      const response = await fetch(`${model.url}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: 'Bearer fixture-only', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: input }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ choices: [{ message: { content: `Echo: ${input}` } }] });
    }
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.path).toBe('/v1/chat/completions');
  } finally { await model.stop(); }
});
