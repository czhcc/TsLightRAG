import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { generationHandler, isGeneration, sseDelta } from '../helpers/generation.js';

test('S10 application: configure three endpoints, import, query five modes, trace graph, delete shared sources and restart', async ({ page }) => {
  test.setTimeout(90_000); page.setDefaultTimeout(10_000);
  const directory = await temporaryDirectory(); let hold = false, cancelled = false;
  const text = await startFakeModel((request, response) => {
    if (hold && isGeneration(request)) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sseDelta('**部分回答** [1]'));
      response.on('close', () => { cancelled = true; });
    } else generationHandler(request, response);
  });
  const embedding = await startFakeModel((request, response) => {
    const input = (request.body as { input: string[] }).input;
    response.end(JSON.stringify({ data: input.map((s, index) => ({ index, embedding: [s.length, 1] })) }));
  });
  const rerank = await startFakeModel((request, response) => {
    const documents = (request.body as { documents: string[] }).documents;
    response.end(JSON.stringify({ results: documents.map((_, index) => ({ index, relevance_score: 1 / (index + 1) })) }));
  });
  let service = await startService(['--data-dir', directory.path]);
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if ([text.url, embedding.url, rerank.url].some(url => r.url().startsWith(url))) external.push(r.url()); });
  try {
    await page.goto(`${service.address}/graph`);
    await expect(page.getByText('暂无图谱，请先配置模型并导入文档完成索引。')).toBeVisible();
    await page.getByRole('link', { name: '模型设置', exact: true }).click();
    for (const kind of ['文本模型', '向量模型', '重排模型']) await page.getByRole('button', { name: `添加${kind}` }).click();
    const groups = [1, 2, 3].map(n => page.getByRole('group', { name: `配置 ${n}`, exact: true }));
    await groups[0]!.getByLabel('Base URL', { exact: true }).fill(`${text.url}/v1`);
    await groups[0]!.getByLabel(/API key/).fill('s10-synthetic-secret');
    await groups[1]!.getByLabel('Base URL', { exact: true }).fill(`${embedding.url}/v1`);
    await groups[1]!.getByLabel('维度', { exact: true }).fill('2');
    await groups[2]!.getByLabel('完整重排 endpoint', { exact: true }).fill(`${rerank.url}/rank`);
    for (const group of groups) {
      await group.getByRole('button', { name: '测试连接（发送示例）' }).click();
      await expect(page.getByRole('status').filter({ hasText: '测试通过' })).toBeVisible();
    }
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('模型配置已保存', { exact: true })).toBeVisible();
    await expect(groups[0]!.getByLabel(/API key/)).toHaveValue('');
    await page.getByRole('link', { name: '文档', exact: true }).click();
    await page.getByRole('button', { name: '粘贴文本', exact: true }).click();
    await page.getByLabel('文档名称', { exact: true }).fill('共享甲.txt');
    await page.getByLabel('文档正文', { exact: true }).fill('first document Alpha Beta cooperation <img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: '导入文本', exact: true }).click();
    await expect(page.getByRole('region', { name: '任务详情' }).getByText('状态：已索引', { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '导入文档', exact: true }).click();
    const transfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['second document Alpha Beta Gamma cooperation'], '共享乙.txt', { type: 'text/plain' })); return transfer;
    });
    await page.getByRole('region', { name: '拖放文件导入' }).dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
    await expect(page.getByRole('heading', { name: '任务详情：共享乙.txt', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '任务详情' }).getByText('状态：已索引', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('共 2 个文档', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByLabel('按名称过滤', { exact: true }).fill('共享乙');
    await expect(page.getByText('共 1 个文档', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: '按状态过滤', exact: true }).selectOption('failed');
    await expect(page.getByText('共 0 个文档', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '检索预览', exact: true }).click();
    await page.getByRole('textbox', { name: '检索问题', exact: true }).fill('Alpha cooperation?');
    await page.getByLabel('启用重排', { exact: true }).check();
    for (const mode of ['naive', 'local', 'global', 'hybrid', 'mix']) {
      await page.getByRole('combobox', { name: '检索模式', exact: true }).selectOption(mode);
      await page.getByRole('button', { name: '检索证据', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('找到 2 个文本块');
    }
    await page.getByRole('button', { name: '生成回答', exact: true }).click();
    const answer = page.getByRole('region', { name: '知识库回答', exact: true });
    await expect(answer.getByRole('status')).toHaveText('回答完成');
    await expect(answer.locator('.markdown')).toContainText('[1]');
    await answer.locator('summary').first().click();
    await expect(answer.getByRole('link', { name: '查看来源文档' }).first()).toBeVisible();
    hold = true; await page.getByRole('textbox', { name: '检索问题', exact: true }).fill('停止本轮回答');
    await page.getByRole('button', { name: '生成回答', exact: true }).click();
    await expect(answer.locator('strong')).toHaveText('部分回答');
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(answer.getByRole('status')).toContainText('回答已取消'); await expect.poll(() => cancelled).toBe(true); hold = false;
    await page.getByRole('link', { name: '知识图谱', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('显示 3 / 3 个节点、2 / 2 条关系');
    await page.getByLabel('节点上限', { exact: true }).fill('1'); await page.getByRole('button', { name: '搜索图谱' }).click();
    await expect(page.getByRole('status')).toContainText('显示 1 / 3 个节点'); await expect(page.getByRole('status')).toContainText('已达上限');
    await page.getByLabel('节点上限', { exact: true }).fill('50'); await page.getByLabel('实体名称', { exact: true }).fill('Alpha');
    await page.getByRole('button', { name: '搜索图谱' }).click(); await page.getByRole('button', { name: 'Alpha', exact: true }).click();
    await expect(page.getByText('共 2 个来源块', { exact: true })).toBeVisible();
    const properties = page.getByRole('region', { name: '图谱属性', exact: true });
    await expect(properties.getByRole('heading', { name: '共享甲.txt', exact: true })).toBeVisible();
    await expect(properties.getByRole('heading', { name: '共享乙.txt', exact: true })).toBeVisible();
    expect(await properties.locator('img,script').count()).toBe(0);
    await page.getByRole('combobox', { name: '搜索对象', exact: true }).selectOption('edges');
    await page.getByLabel('关系关键词', { exact: true }).fill('cooperate');
    await page.getByRole('button', { name: '搜索图谱' }).click();
    await expect(page.getByRole('region', { name: '图谱关系', exact: true }).getByRole('button')).toHaveCount(1);
    await page.getByRole('region', { name: '图谱关系', exact: true }).getByRole('button').click();
    await expect(properties.getByText(/权重：/)).toBeVisible();
    await page.getByRole('button', { name: 'Alpha', exact: true }).click();
    await page.getByRole('button', { name: '展开邻居' }).click();
    await expect(page.getByRole('status')).toHaveText('显示 3 / 3 个节点、2 / 2 条关系');
    await page.getByRole('button', { name: 'Alpha', exact: true }).click();
    await properties.locator('article').filter({ has: page.getByRole('heading', { name: '共享甲.txt', exact: true }) }).getByRole('link', { name: '查看来源文档' }).click();
    await expect(page.getByRole('heading', { name: '任务详情：共享甲.txt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('row').filter({ hasText: '共享甲.txt' }).getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByText('共 1 个文档', { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole('link', { name: '知识图谱', exact: true }).click();
    await page.getByRole('button', { name: '刷新图谱' }).click();
    await page.getByRole('button', { name: 'Alpha', exact: true }).click();
    await expect(page.getByText('共 1 个来源块', { exact: true })).toBeVisible();
    await expect(properties.getByRole('heading', { name: '共享乙.txt', exact: true })).toBeVisible();
    await expect(properties.getByRole('heading', { name: '共享甲.txt', exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('s10-graph.png'), fullPage: true });
    expect(text.requests.length).toBeGreaterThan(1); expect(embedding.requests.length).toBeGreaterThan(1); expect(rerank.requests.length).toBeGreaterThan(1);
    const calls = text.requests.length + embedding.requests.length + rerank.requests.length;
    expect(await service.stop()).toBe(0); service = await startService(['--data-dir', directory.path]);
    await page.goto(`${service.address}/graph`); await page.getByRole('button', { name: 'Alpha', exact: true }).click();
    await expect(page.getByText('共 1 个来源块', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '模型设置', exact: true }).click();
    await expect(page.getByText('已保存模型：3 · 当前配置版本：1')).toBeVisible();
    await expect(groups[0]!.getByLabel(/API key/)).toHaveValue('');
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(text.requests.length + embedding.requests.length + rerank.requests.length).toBe(calls);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await service.stop(); await text.stop(); await embedding.stop(); await rerank.stop(); await directory.cleanup(); }
});
