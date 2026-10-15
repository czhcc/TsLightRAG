import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDocument } from './index.js';
import { startFakeModel } from '../../../../tests/helpers/fake-model.js';
import { documentFixture, editOffice, xmlBytes } from '../../../../tests/helpers/document-fixtures.js';
it('parses every real format with worker network entry points disabled', async () => {
  for (const ext of ['txt', 'md', 'html', 'csv', 'json', 'pdf', 'docx', 'xlsx', 'pptx']) {
    expect((await parseDocument(await documentFixture(`sample.${ext}`), `sample.${ext}`)).blocks.length).toBeGreaterThan(0);
  }
});
it('HTML/Markdown external assets and Office external relations make zero HTTP requests', async () => {
  const trap = await startFakeModel((_r, res) => { res.writeHead(500).end(); });
  try {
    const html = `<link rel="stylesheet" href="${trap.url}/css"><script src="${trap.url}/js"></script><img src="${trap.url}/img"><iframe src="${trap.url}/frame"></iframe><p>本地证据</p>`;
    expect((await parseDocument(Buffer.from(html), 'external.html')).text).toBe('本地证据');
    expect((await parseDocument(Buffer.from(`本地证据 [link](${trap.url}) ![图片](${trap.url}/img)`), 'external.md')).text).toContain('本地证据');
    const office = await editOffice('docx', (files) => { files['word/_rels/document.xml.rels'] = xmlBytes(`<Relationships><Relationship Id="x" Target="${trap.url}/private" TargetMode="External"/></Relationships>`); });
    expect((await parseDocument(office, 'external.docx')).warnings.some((w) => w.code === 'EXTERNAL_RESOURCES_IGNORED')).toBe(true);
    expect(trap.requests).toHaveLength(0);
  } finally { await trap.stop(); }
});
it('actual guard rejects fetch and dynamically imported HTTP/HTTPS/TCP entry points', async () => {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../../tests/fixtures/parser-network-probe.mjs', import.meta.url))], { env: {} });
  expect(result.stdout).toBe('network guards rejected all probes\n');
});
it('isolates a real worker heap exhaustion from the parent process', async () => {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../../tests/fixtures/parser-resource-probe.mjs', import.meta.url))], { env: {}, timeout: 8000 });
  expect(result.stdout).toBe('worker heap failure isolated\n');
});
