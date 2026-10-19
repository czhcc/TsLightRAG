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
    await expect(page.getByText('已初始化', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '模型角色' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('s02-model-settings.png'), fullPage: true });
  } finally { expect(await service.stop()).toBe(0); }
});

test('production UI and same-origin settings writes work through an IP on wildcard listening', async ({ page }) => {
  const service = await startService(['--host', '0.0.0.0']);
  // Browser runners may route non-loopback traffic through an external proxy.
  // Verify real same-origin browser writes locally; NIC routing/Host is covered
  // by the direct HTTP integration test without changing runner proxy policy.
  const address = `http://127.0.0.1:${new URL(service.address).port}`;
  try {
    await page.goto(`${address}/settings/models`);
    await expect(page.getByRole('heading', { name: '模型角色' })).toBeVisible();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('模型配置已保存', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('已保存模型：0 · 当前配置版本：1')).toBeVisible();
  } finally { await service.stop(); }
});
