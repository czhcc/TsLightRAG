import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startService } from '../helpers/owned-service.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';

test('browser imports text/file, reads persisted progress/preview, deduplicates, cancels/retries and survives restart', async ({ page }) => {
  const directory = await temporaryDirectory(); let service = await startService(['--data-dir', directory.path]);
  const errors: string[] = []; page.on('pageerror', (e) => { errors.push(e.message); });
  try {
    await page.goto(`${service.address}/documents`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '索引维护' })).toHaveCount(0);
    await page.getByRole('button', { name: '粘贴文本', exact: true }).click();
    await page.getByLabel('文档名称', { exact: true }).fill('浏览器笔记.txt');
    await page.getByLabel('文档正文', { exact: true }).fill('本地文档证据 🧮\n\n第二段');
    await page.getByRole('button', { name: '导入文本', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '原文和任务已持久保存' })).toBeVisible();
    const detail = page.getByRole('region', { name: '任务详情', exact: true });
    await expect(detail.getByText('状态：待配置模型', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '查看解析正文' }).click();
    await expect(detail.getByLabel('解析正文')).toHaveText('本地文档证据 🧮\n\n第二段');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '粘贴文本', exact: true }).click();
    await page.getByRole('button', { name: '导入文本', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '相同内容已存在' })).toBeVisible();
    await expect(page.getByText('共 1 个文档', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '取消任务' }).click();
    await expect(detail.getByText('状态：已取消', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '重试任务' }).click();
    await expect(detail.getByText(/尝试次数：2/)).toBeVisible();
    await expect(detail.getByText('状态：待配置模型', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '导入文档', exact: true }).click();
    await page.getByLabel('选择文件', { exact: true }).setInputFiles(fileURLToPath(new URL('../fixtures/documents/sample.docx', import.meta.url)));
    await expect(page.getByText('共 2 个文档', { exact: true })).toBeVisible();
    await expect(detail.getByText('状态：待配置模型', { exact: true })).toBeVisible();
    expect(await service.stop()).toBe(0); service = await startService(['--data-dir', directory.path]);
    await page.goto(`${service.address}/documents`);
    await expect(page.getByText('共 2 个文档', { exact: true })).toBeVisible();
    await page.getByRole('row').filter({ hasText: '浏览器笔记.txt' }).getByRole('button', { name: '查看', exact: true }).click();
    await expect(detail.getByText(/尝试次数：2/)).toBeVisible();
    await detail.getByRole('button', { name: '查看解析正文' }).click();
    await expect(detail.getByLabel('解析正文')).toHaveText('本地文档证据 🧮\n\n第二段');
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('s05-documents.png'), fullPage: true });
  } finally { await service.stop(); await directory.cleanup(); }
});
