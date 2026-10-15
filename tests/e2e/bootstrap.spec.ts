import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';

test('production UI calls real API and opens model settings with no configuration', async ({ page }) => {
  const service = await startService();
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  page.on('request', (request) => {
    if (!request.url().startsWith(service.address)) unexpected.push(request.url());
  });
  try {
    await page.goto(service.address);
    await expect(page.getByRole('heading', { name: '让知识有据可循' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '服务已启动，知识库尚未就绪' })).toBeVisible();
    await page.getByRole('link', { name: '查看模型设置' }).click();
    await expect(page).toHaveURL(`${service.address}/settings/models`);
    for (const name of ['文本模型', '向量模型', '重排模型']) {
      await expect(page.getByRole('heading', { name })).toBeVisible();
    }
    await expect(page.getByText('已保存模型：0 · 当前配置版本：0')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '模型角色' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('s01-model-settings.png'), fullPage: true });
  } finally { expect(await service.stop()).toBe(0); }
});
