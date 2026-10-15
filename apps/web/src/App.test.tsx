// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { ApplicationApi } from './api/client.js';

const health = { status: 'ok', stage: 'S05', usable: false, models: { configured: false, missingRoles: ['query', 'embedding'] }, storage: { initialized: true, status: 'ready', generation: 'g-test', revision: 0, corpusRevision: 0 }, jobs: { available: true } } as const;
const settings = { revision: 0, profiles: [], editingAvailable: false, bindings: { query: null, extract: null, keyword: null, embedding: null, rerank: null } };
function fakeApi(): ApplicationApi {
  return { health: vi.fn().mockResolvedValue(health), models: vi.fn().mockResolvedValue(settings), saveModels: vi.fn(), testModel: vi.fn() };
}
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); });
it('shows startup is live while indexing and models remain unavailable', async () => {
  render(<App api={fakeApi()} />);
  expect(await screen.findByText('服务已启动，知识库尚未就绪')).toBeTruthy();
  expect(screen.getByRole('link', { name: '查看模型设置' }).getAttribute('href')).toBe('/settings/models');
  expect(screen.queryByRole('textbox')).toBeNull();
});
it('renders three model roles and real configuration actions', async () => {
  window.history.replaceState({}, '', '/settings/models');
  render(<App api={fakeApi()} />);
  expect(await screen.findByRole('heading', { name: '模型角色' })).toBeTruthy();
  for (const name of ['文本模型', '向量模型', '重排模型']) expect(screen.getByRole('heading', { name })).toBeTruthy();
  expect(screen.getByRole('button', { name: '保存配置' })).toBeTruthy();
  expect(screen.getByText('已保存模型：0 · 当前配置版本：0')).toBeTruthy();
});
it('shows a network failure and retries the actual API boundary', async () => {
  const api = fakeApi();
  vi.mocked(api.health).mockRejectedValueOnce(new Error('offline'));
  render(<App api={api} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '重新检查' }));
  expect(await screen.findByText('服务已启动，知识库尚未就绪')).toBeTruthy();
  expect(api.health).toHaveBeenCalledTimes(2);
});
it('aborts owned outstanding requests on unmount', () => {
  const api = fakeApi();
  const view = render(<App api={api} />);
  const signal = vi.mocked(api.health).mock.calls[0]?.[0];
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
