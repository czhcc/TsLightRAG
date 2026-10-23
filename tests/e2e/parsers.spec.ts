import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';

test('production UI displays the actual local parser capability matrix and budgets', async ({ page }) => {
  const service = await startService();
  try {
    await page.goto(service.address);
    await expect(page.getByRole('region', { name: '本地解析能力' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link').last()).toHaveText('关于');
    await page.getByRole('link', { name: '关于', exact: true }).click();
    await expect(page).toHaveURL(`${service.address}/about`);
    await expect(page.getByRole('heading', { name: '关于 TsLightRAG', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '关于', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.reload();
    const section = page.getByRole('region', { name: '本地解析能力' });
    await expect(section.getByRole('heading', { name: '本地解析能力' })).toBeVisible();
    for (const format of ['TXT', 'Markdown', 'HTML', 'CSV', 'JSON', 'PDF', 'DOCX', 'XLSX', 'PPTX']) await expect(section.getByRole('cell', { name: format, exact: true })).toBeVisible();
    await expect(section.getByText(/单文件 20 MiB/)).toBeVisible();
    await expect(section.getByText(/不支持：扫描件 OCR/)).toBeVisible();
    const response = await page.request.get(`${service.address}/api/v1/parsers/capabilities`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ parserVersion: 's04-v1', localOnly: true, limits: { inputBytes: 20971520, zipEntries: 10000 } });
    expect((await response.json() as { formats: unknown[] }).formats).toHaveLength(9);
    expect((await page.request.post(`${service.address}/api/v1/documents`, { data: {} })).status()).toBe(400);
    await page.screenshot({ path: test.info().outputPath('s04-capabilities.png'), fullPage: true });
    for (const path of ['/documents', '/query', '/graph', '/chat', '/settings/models']) {
      await page.goto(`${service.address}${path}`);
      await expect(page.getByRole('region', { name: '本地解析能力' })).toHaveCount(0);
    }
  } finally { await service.stop(); }
});
