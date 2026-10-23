import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { reply } from '../helpers/indexing.js';
import { textProfile, embeddingProfile, bindings } from '../helpers/model-profiles.js';

test('graph starts empty, accumulates searches and double-click expansion, lays out objects and paginates both tables', async ({ page }) => {
  const names = Array.from({ length: 25 }, (_, i) => `Entity ${String(i + 1).padStart(2, '0')}`);
  const model = await startFakeModel((request, response) => {
    const body = request.body as { input?: string[]; messages?: { role: string }[] };
    if (body.input) response.end(JSON.stringify({ data: body.input.map((s, index) => ({ index, embedding: [s.length, 1] })) }));
    else reply(response, body.messages?.some(m => m.role === 'assistant') ? { entities: [], relationships: [] } : {
      entities: names.map(name => ({ name, type: 'Concept', description: `${name} is documented.` })),
      relationships: names.slice(1).map((name, i) => ({ source: names[i], target: name, description: `${names[i]} connects ${name}.`, keywords: 'connection', strength: 1 })),
    });
  });
  const service = await startService(), errors: string[] = [], graphCalls: string[] = [];
  page.on('pageerror', e => { errors.push(e.message); });
  page.on('request', r => { if (r.url().includes('/api/v1/graph')) graphCalls.push(r.url()); });
  try {
    expect((await page.request.put(`${service.address}/api/v1/settings/models`, { data: { expectedRevision: 0, profiles: [textProfile(model.url), embeddingProfile(model.url)], bindings: { ...bindings, rerank: null } } })).status()).toBe(200);
    const imported = await page.request.post(`${service.address}/api/v1/documents/text`, { data: { name: 'graph.txt', text: 'A chain of 25 documented entities.' } });
    const document = await imported.json() as { document: { id: string; version: number }; job: { id: string } };
    await expect.poll(async () => (await (await page.request.get(`${service.address}/api/v1/jobs/${document.job.id}`)).json() as { status: string }).status).toBe('processed');
    await page.goto(`${service.address}/graph`);
    await expect(page.getByText('请输入实体名称或关系关键词搜索，结果会逐步加入关联图。')).toBeVisible();
    expect(graphCalls).toEqual([]);
    const entities = page.getByRole('region', { name: '图谱实体', exact: true }), relations = page.getByRole('region', { name: '图谱关系', exact: true });
    await expect(entities.getByRole('table').getByRole('button')).toHaveCount(0);
    const input = page.getByLabel('实体名称', { exact: true });
    const search = async (q: string) => { await input.fill(q); await page.getByRole('button', { name: '搜索图谱', exact: true }).click(); };
    await search('Entity 01'); await expect(page.getByRole('status').filter({ hasText: /^显示/ })).toHaveText('显示 1 / 25 个节点、0 / 24 条关系');
    const inputBox = (await input.boundingBox())!, buttonBox = (await page.getByRole('button', { name: '搜索图谱', exact: true }).boundingBox())!;
    expect(Math.abs(inputBox.y + inputBox.height - buttonBox.y - buttonBox.height)).toBeLessThan(2);
    await search('Entity 02'); await expect(page.getByRole('status').filter({ hasText: /^显示/ })).toHaveText('显示 2 / 25 个节点、0 / 24 条关系');
    await expect(page.getByRole('button', { name: '图谱实体：Entity 01', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '图谱实体：Entity 02', exact: true }).dblclick();
    await expect(page.getByRole('status').filter({ hasText: '显示' })).toHaveText('显示 3 / 25 个节点、2 / 24 条关系');
    await search('Entity'); await expect(page.getByRole('status').filter({ hasText: '显示' })).toHaveText('显示 25 / 25 个节点、24 / 24 条关系');
    await expect(entities.getByRole('table').getByRole('row')).toHaveCount(11);
    await expect(relations.getByRole('table').getByRole('row')).toHaveCount(11);
    await entities.getByLabel('实体每页行数', { exact: true }).selectOption('20');
    await expect(entities.getByRole('table').getByRole('row')).toHaveCount(21);
    await entities.getByRole('button', { name: '下一页实体', exact: true }).click(); await expect(entities.getByRole('table').getByRole('row')).toHaveCount(6);
    await relations.getByRole('button', { name: '下一页关系', exact: true }).click();
    await expect(relations.getByRole('table').getByRole('row')).toHaveCount(11);
    await relations.getByLabel('关系每页行数', { exact: true }).selectOption('50'); await expect(relations.getByRole('table').getByRole('row')).toHaveCount(25);
    for (const layout of ['circle', 'grid', 'hierarchy', 'force']) {
      await page.getByLabel('布局方式', { exact: true }).selectOption(layout); await expect(page.getByRole('group', { name: '关联图', exact: true })).toHaveAttribute('data-layout', layout);
    }
    await search('not-existing'); await expect(page.getByText('本次未找到匹配对象，已保留之前的探索结果。')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '显示' })).toHaveText('显示 25 / 25 个节点、24 / 24 条关系');
    await page.screenshot({ path: test.info().outputPath('graph-exploration.png'), fullPage: true });
    const maintenance = await (await page.request.get(`${service.address}/api/v1/maintenance`)).json() as { corpusRevision: number };
    const deleted = await page.request.delete(`${service.address}/api/v1/documents/${document.document.id}`, { data: { expectedCorpusRevision: maintenance.corpusRevision, expectedConfigRevision: 1, expectedDocumentVersion: 1 } });
    const deletion = await deleted.json() as { id: string }; expect(deleted.status()).toBe(202);
    await expect.poll(async () => (await (await page.request.get(`${service.address}/api/v1/jobs/${deletion.id}`)).json() as { status: string }).status).toBe('processed');
    await page.getByRole('button', { name: '刷新图谱', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /^显示/ })).toHaveText('显示 0 / 0 个节点、0 / 0 条关系');
    await expect(entities.getByRole('table').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '图谱属性', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await service.stop(); await model.stop(); }
});
