// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Documents } from './Documents.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('applies filters on the server and paginates; rejects oversized or unsupported drops before uploading', async () => {
  const mock = vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => {
    if (url.includes('/documents?')) return { items: [], total: 12, offset: Number(new URL(`http://localhost${url}`).searchParams.get('offset')), limit: 10 };
    if (url.endsWith('/maintenance')) return { corpusRevision: 0, activeIndex: null, jobs: [], cleanupTasks: [] };
    return { revision: 0, profiles: [], bindings: { query: null, extract: null, keyword: null, embedding: null, rerank: null }, editingAvailable: true };
  } }));
  vi.stubGlobal('fetch', mock); render(<Documents />);
  await screen.findByText('共 12 个文档');
  await userEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(mock.mock.calls.some(([url]) => String(url).includes('offset=10'))).toBe(true));
  await userEvent.type(screen.getByLabelText('按名称过滤'), 'Alpha');
  await userEvent.selectOptions(screen.getByLabelText('按状态过滤'), 'failed');
  await waitFor(() => expect(mock.mock.calls.some(([url]) => String(url).includes('offset=0') && String(url).includes('q=Alpha') && String(url).includes('status=failed'))).toBe(true));
  const zone = screen.getByRole('region', { name: '拖放文件导入' });
  fireEvent.drop(zone, { dataTransfer: { files: [new File(['bad'], 'bad.exe')] } });
  expect(await screen.findByText('不支持的文件格式，请选择能力矩阵中的格式')).toBeTruthy();
  const oversized = new File(['x'], 'large.txt'); Object.defineProperty(oversized, 'size', { value: 20 * 1024 * 1024 + 1 });
  fireEvent.drop(zone, { dataTransfer: { files: [oversized] } });
  expect(await screen.findByText('文件不能为空或超过 20 MiB')).toBeTruthy();
  expect(mock.mock.calls.every(([, options]) => !(options as RequestInit).method)).toBe(true);
});
