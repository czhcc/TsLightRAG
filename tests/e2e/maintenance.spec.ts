import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { kgHandler } from '../helpers/indexing.js';
import { textProfile, embeddingProfile, bindings } from '../helpers/model-profiles.js';

test('document rows confirm reindex/delete, preserve the old index on failure and expose retry in a task dialog', async ({ page }) => {
  const dir = await temporaryDirectory(); let fail = false;
  const model = await startFakeModel((request, response) => {
    if (fail && request.path.endsWith('/chat/completions')) response.writeHead(401).end('private provider detail');
    else kgHandler(request, response);
  });
  let service = await startService(['--data-dir', dir.path]);
  const errors: string[] = []; page.on('pageerror', e => { errors.push(e.message); });
  try {
    const saved = await page.request.put(`${service.address}/api/v1/settings/models`, { data: { expectedRevision: 0,
      profiles: [textProfile(model.url), embeddingProfile(model.url)], bindings: { ...bindings, rerank: null } } });
    expect(saved.status()).toBe(200);
    await page.goto(`${service.address}/documents`);
    await page.getByRole('button', { name: '粘贴文本', exact: true }).click();
    await page.getByLabel('文档正文', { exact: true }).fill('first document');
    await page.getByRole('button', { name: '导入文本', exact: true }).click();
    const detail = page.getByRole('region', { name: '任务详情', exact: true });
    await expect(detail.getByText('状态：已索引', { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: '文档.txt' });
    await expect(row.getByRole('button')).toHaveText(['查看', '删除', '重新索引']);
    const calls = model.requests.length;
    await row.getByRole('button', { name: '重新索引', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    expect(model.requests).toHaveLength(calls);
    await row.getByRole('button', { name: '重新索引', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认重新索引', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('重新索引已完成', { timeout: 15000 });
    await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible();
    fail = true;
    await row.getByRole('button', { name: '重新索引', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认重新索引', exact: true }).click();
    await expect(row).toContainText('重新索引失败', { timeout: 15000 });
    await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible();
    await row.getByRole('button', { name: '查看', exact: true }).click();
    await expect(detail.getByRole('alert')).toContainText('MODEL_AUTH_FAILED');
    await expect(detail).not.toContainText('private provider detail');
    fail = false;
    await detail.getByRole('button', { name: '重试任务', exact: true }).click();
    await expect(detail.getByText('状态：已索引', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(detail).toContainText('文档版本：3');
    await detail.getByRole('button', { name: '查看解析正文' }).click();
    await expect(detail.getByLabel('解析正文')).toHaveText('first document');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('region', { name: '索引维护', exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('document-list.png'), fullPage: true });
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row.getByRole('button', { name: '删除', exact: true })).toBeFocused();
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByText('共 0 个文档', { exact: true })).toBeVisible({ timeout: 15000 });
    const requests = model.requests.length;
    expect(await service.stop()).toBe(0); service = await startService(['--data-dir', dir.path]);
    await page.goto(`${service.address}/documents`);
    await expect(page.getByText('共 0 个文档', { exact: true })).toBeVisible();
    expect(model.requests).toHaveLength(requests); expect(errors).toEqual([]);
  } finally { await service.stop(); await model.stop(); await dir.cleanup(); }
});
