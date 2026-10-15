import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';

test('production UI displays the actual local parser capability matrix and budgets', async ({ page }) => {
  const service = await startService();
  try {
    await page.goto(service.address);
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
  } finally { await service.stop(); }
});
