import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { generationHandler, isGeneration, sseDelta } from '../helpers/generation.js';
import { textProfile, embeddingProfile, rerankProfile, bindings } from '../helpers/model-profiles.js';

test('knowledge chat retains independent histories, follow-ups, retrieval settings and citations after reload and restart', async ({ page }) => {
  const directory = await temporaryDirectory();
  const model = await startFakeModel((request, response) => {
    if (request.path === '/rerank') {
      const body = request.body as { documents: string[]; top_n: number };
      response.end(JSON.stringify({ results: body.documents.slice(0, body.top_n).map((_, index) => ({ index, relevance_score: 1 })) }));
    } else generationHandler(request, response);
  });
  let service = await startService(['--data-dir', directory.path]);
  const errors: string[] = []; page.on('pageerror', e => { errors.push(e.message); });
  try {
    const saved = await page.request.put(`${service.address}/api/v1/settings/models`, { data: { expectedRevision: 0,
      profiles: [textProfile(model.url), embeddingProfile(model.url), rerankProfile(`${model.url}/rerank`)], bindings } });
    expect(saved.status()).toBe(200);
    const imported = await page.request.post(`${service.address}/api/v1/documents/text`, { data: { name: '协作文档.txt', text: 'first document Alpha Beta cooperation' } });
    const job = (await imported.json() as { job: { id: string } }).job.id;
    await expect.poll(async () => (await (await page.request.get(`${service.address}/api/v1/jobs/${job}`)).json() as { status: string }).status).toBe('processed');
    await page.goto(service.address);
    await page.getByRole('link', { name: '知识问答', exact: true }).click();
    await expect(page.getByRole('heading', { name: '知识问答', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.getByLabel('检索模式', { exact: true }).selectOption('naive');
    await page.getByLabel('来源块选择', { exact: true }).selectOption('WEIGHT');
    await page.getByLabel('关联块数量', { exact: true }).fill('7');
    await page.getByLabel('启用重排', { exact: true }).check();
    await page.getByLabel('输入问题', { exact: true }).fill('Alpha 如何协作？');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('article', { name: '回答 1', exact: true })).toContainText('回答完成');
    await expect(page.getByRole('article', { name: '回答 1', exact: true })).toContainText('Alpha 与 Beta 协作');
    await page.getByText('查看来源（1）', { exact: true }).click();
    await expect(page.getByRole('link', { name: '[1] 协作文档.txt', exact: true })).toBeVisible();
    const firstUrl = page.url();
    await page.getByLabel('输入问题', { exact: true }).fill('继续解释刚才的合作。');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('article', { name: '回答 2', exact: true })).toContainText('回答完成');
    const body = model.requests.filter(isGeneration).at(-1)?.body as { messages: { role: string; content: string }[] };
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'Alpha 如何协作？' }, { role: 'assistant', content: 'Alpha 与 Beta 协作 [1]。' }, { role: 'user', content: '继续解释刚才的合作。' }]);
    expect(model.requests.some(r => r.path === '/rerank')).toBe(true);
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await expect(page.getByRole('article', { name: '问题 1', exact: true })).toHaveCount(0);
    await page.getByLabel('输入问题', { exact: true }).fill('独立的新问题');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('article', { name: '回答 1', exact: true })).toContainText('回答完成');
    await page.getByRole('button', { name: /Alpha 如何协作？/ }).click();
    await expect(page.getByRole('article', { name: '问题 2', exact: true })).toContainText('继续解释刚才的合作');
    await page.reload();
    await expect(page.getByRole('article', { name: '回答 2', exact: true })).toContainText('回答完成');
    await expect(page.getByLabel('来源块选择', { exact: true })).toHaveValue('WEIGHT');
    await expect(page.getByLabel('关联块数量', { exact: true })).toHaveValue('7');
    await expect(page.getByLabel('启用重排', { exact: true })).toBeChecked();
    expect(await service.stop()).toBe(0); service = await startService(['--data-dir', directory.path]);
    await page.goto(`${service.address}${new URL(firstUrl).pathname}${new URL(firstUrl).search}`);
    await expect(page.getByRole('article', { name: '回答 2', exact: true })).toContainText('回答完成');
    await expect(page.getByRole('button', { name: /独立的新问题/ })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('knowledge-chat.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    page.once('dialog', dialog => { void dialog.accept(); });
    await page.getByRole('button', { name: '删除对话', exact: true }).click();
    await expect(page.getByRole('button', { name: /Alpha 如何协作？/ })).toHaveCount(0);
  } finally { await service.stop(); await model.stop(); await directory.cleanup(); }
});

test('chat stops partial generation, preserves failed turns and recovers for another question', async ({ page }) => {
  let mode = 'slow';
  const model = await startFakeModel((request, response) => {
    if (!isGeneration(request)) return generationHandler(request, response);
    if (mode === 'slow') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sseDelta('部分回答')); }
    else if (mode === 'fail') response.writeHead(401).end('private provider detail');
    else generationHandler(request, response);
  });
  const service = await startService();
  try {
    await page.request.put(`${service.address}/api/v1/settings/models`, { data: { expectedRevision: 0, profiles: [textProfile(model.url, { timeoutMs: 10000 }), embeddingProfile(model.url)], bindings: { ...bindings, rerank: null } } });
    const imported = await page.request.post(`${service.address}/api/v1/documents/text`, { data: { name: 'evidence.txt', text: 'first document Alpha Beta' } });
    const job = (await imported.json() as { job: { id: string } }).job.id;
    await expect.poll(async () => (await (await page.request.get(`${service.address}/api/v1/jobs/${job}`)).json() as { status: string }).status).toBe('processed');
    await page.goto(`${service.address}/chat`); await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.getByLabel('输入问题', { exact: true }).fill('Alpha?'); await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('article', { name: '回答 1', exact: true })).toContainText('部分回答');
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(page.getByRole('article', { name: '回答 1', exact: true })).toContainText('已停止');
    mode = 'fail';
    await page.getByLabel('输入问题', { exact: true }).fill('再次问 Alpha'); await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('article', { name: '回答 2', exact: true })).toContainText('MODEL_AUTH_FAILED');
    await expect(page.getByRole('article', { name: '回答 2', exact: true })).not.toContainText('private provider detail');
    await page.reload(); await expect(page.getByRole('article', { name: '回答 1', exact: true })).toContainText('部分回答');
    mode = 'normal';
    await page.getByLabel('输入问题', { exact: true }).fill('Alpha 现在如何协作？'); await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('article', { name: '回答 3', exact: true })).toContainText('回答完成');
  } finally { await service.stop(); await model.stop(); }
});
