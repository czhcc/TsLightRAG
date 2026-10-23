import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { chatReply } from '../helpers/model-profiles.js';

test('browser configures three real endpoints, tests unsaved candidates and restores saved roles/keys after restart', async ({ page }) => {
  const directory = await temporaryDirectory();
  const text = await startFakeModel((_r, res) => { res.end(JSON.stringify(chatReply)); });
  const embedding = await startFakeModel((_r, res) => { res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] })); });
  const rerank = await startFakeModel((_r, res) => { res.end(JSON.stringify({ results: [{ index: 1, relevance_score: 1 }, { index: 0, relevance_score: 0 }] })); });
  let service = await startService(['--data-dir', directory.path]);
  const errors: string[] = []; page.on('pageerror', (e) => { errors.push(e.message); });
  const browserModelCalls: string[] = []; page.on('request', (r) => { if ([text.url, embedding.url, rerank.url].some((url) => r.url().startsWith(url))) browserModelCalls.push(r.url()); });
  try {
    await page.goto(`${service.address}/settings/models`);
    for (const name of ['文本模型', '向量模型', '重排模型']) await page.getByRole('button', { name: `添加${name}` }).click();
    const groups = [1, 2, 3].map((n) => page.getByRole('group', { name: `配置 ${String(n)}`, exact: true }));
    await groups[0]!.getByLabel('Base URL', { exact: true }).fill(`${text.url}/v1`);
    await groups[0]!.getByLabel('模型名称', { exact: true }).fill('browser-text');
    await groups[0]!.getByLabel(/API key/).fill('browser-synthetic-secret');
    const extraBody = { chat_template_kwargs: { enable_thinking: false } };
    await groups[0]!.getByLabel('扩展参数（JSON 对象）', { exact: true }).fill(JSON.stringify(extraBody, null, 2));
    await groups[1]!.getByLabel('Base URL', { exact: true }).fill(`${embedding.url}/v1`);
    await groups[1]!.getByLabel('维度', { exact: true }).fill('2');
    await groups[2]!.getByLabel('完整重排 endpoint', { exact: true }).fill(`${rerank.url}/rank`);
    for (const group of groups) {
      await group.getByRole('button', { name: '测试连接（发送示例）' }).click();
      await expect(page.getByRole('status').filter({ hasText: /测试通过/ })).toBeVisible();
    }
    expect([text.requests.length, embedding.requests.length, rerank.requests.length]).toEqual([1, 1, 1]);
    expect(text.requests[0]?.body).toMatchObject(extraBody);
    expect((await (await page.request.get(`${service.address}/api/v1/settings/models`)).json() as { revision: number }).revision).toBe(0);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('模型配置已保存', { exact: true })).toBeVisible();
    await expect(page.getByText('已保存模型：3 · 当前配置版本：1')).toBeVisible();
    await expect(groups[0]!.getByLabel(/API key/)).toHaveValue('');
    await page.reload();
    await expect(page.getByText('已保存模型：3 · 当前配置版本：1')).toBeVisible();
    await expect(groups[0]!.getByLabel(/API key（已保存）/)).toHaveValue('');
    await expect(groups[0]!.getByLabel('扩展参数（JSON 对象）', { exact: true })).toHaveValue(JSON.stringify(extraBody, null, 2));
    expect(await (await page.request.get(`${service.address}/api/v1/settings/models`)).text()).not.toContain('browser-synthetic-secret');
    await groups[0]!.getByRole('button', { name: '测试连接（发送示例）' }).click();
    await expect(page.getByRole('status').filter({ hasText: /测试通过/ })).toBeVisible();
    expect(text.requests[1]?.headers.authorization).toBe('Bearer browser-synthetic-secret');
    expect(text.requests[1]?.body).toMatchObject(extraBody);
    expect(await service.stop()).toBe(0); service = await startService(['--data-dir', directory.path]);
    await page.goto(`${service.address}/settings/models`);
    await expect(page.getByText('已保存模型：3 · 当前配置版本：1')).toBeVisible();
    await expect(groups[0]!.getByLabel('模型名称', { exact: true })).toHaveValue('browser-text');
    await expect(groups[0]!.getByLabel('扩展参数（JSON 对象）', { exact: true })).toHaveValue(JSON.stringify(extraBody, null, 2));
    await expect(page.getByLabel('extract 角色')).toHaveValue('');
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await groups[0]!.getByLabel('清除密钥', { exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('已保存模型：3 · 当前配置版本：2')).toBeVisible();
    await groups[0]!.getByRole('button', { name: '测试连接（发送示例）' }).click();
    await expect(page.getByRole('status').filter({ hasText: /测试通过/ })).toBeVisible();
    expect(text.requests[2]?.headers.authorization).toBeUndefined();
    expect(errors).toEqual([]); expect(browserModelCalls).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('s03-model-settings.png'), fullPage: true });
  } finally { await service.stop(); await Promise.all([text.stop(), embedding.stop(), rerank.stop()]); await directory.cleanup(); }
});

test('browser reports version conflict and reloads the actual saved revision', async ({ page }) => {
  const service = await startService();
  try {
    await page.goto(`${service.address}/settings/models`);
    await expect(page.getByText('已保存模型：0 · 当前配置版本：0')).toBeVisible();
    const result = await page.request.put(`${service.address}/api/v1/settings/models`, { data: { expectedRevision: 0, profiles: [], bindings: { query: null, extract: null, keyword: null, embedding: null, rerank: null } } });
    expect(result.status()).toBe(200);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: /HTTP 409/ })).toBeVisible();
    await page.getByRole('button', { name: '重新加载配置' }).click();
    await expect(page.getByText('已保存模型：0 · 当前配置版本：1')).toBeVisible();
  } finally { await service.stop(); }
});
