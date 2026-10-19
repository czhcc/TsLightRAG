// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelSettingsEditor } from './ModelSettings.js';
import { ModelSettingsSchema } from '@tslightrag/contracts';
import { textProfile, embeddingProfile, rerankProfile, bindings } from '../../../tests/helpers/model-profiles.js';
import type { ApplicationApi } from './api/client.js';
afterEach(cleanup);
it('tests independent unsaved endpoints, preserves omitted keys, clears explicitly and reloads conflicts', async () => {
  const profiles = [textProfile('http://127.0.0.1:8001/v1'), embeddingProfile('http://127.0.0.1:8002/v1'), rerankProfile('http://127.0.0.1:8003/rank')].map(p => {
    const { apiKey, ...rest } = p; return { ...rest, hasApiKey: Boolean(apiKey) };
  });
  const initial = ModelSettingsSchema.parse({ profiles, bindings, revision: 1, editingAvailable: true });
  const api: ApplicationApi = { health: vi.fn(), models: vi.fn().mockResolvedValue({ ...initial, revision: 2 }),
    saveModels: vi.fn().mockRejectedValue(new Error('配置版本冲突')), testModel: vi.fn().mockResolvedValue({ ok: true, kind: 'text', message: '测试通过' }) };
  render(<ModelSettingsEditor initial={initial} api={api} onSaved={vi.fn()} />);
  for (let i = 1; i <= 3; i++) {
    const group = within(screen.getByRole('group', { name: `配置 ${i}` }));
    await userEvent.click(group.getByRole('button', { name: '测试连接（发送示例）' }));
    expect(vi.mocked(api.testModel).mock.calls[i - 1]![0].endpoint).toBe(profiles[i - 1]!.endpoint);
  }
  expect(api.saveModels).not.toHaveBeenCalled();
  expect((screen.getAllByLabelText(/API key/)[0] as HTMLInputElement).value).toBe('');
  await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect(vi.mocked(api.saveModels).mock.calls[0]![0].profiles[0]!.apiKey).toBeUndefined();
  expect(await screen.findByText('配置版本冲突')).toBeTruthy();
  await userEvent.click(within(screen.getByRole('group', { name: '配置 1' })).getByLabelText('清除密钥'));
  await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect(vi.mocked(api.saveModels).mock.calls[1]![0].profiles[0]!.apiKey).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '重新加载配置' }));
  expect(await screen.findByText('已保存模型：3 · 当前配置版本：2')).toBeTruthy();
  expect(screen.getByLabelText('extract 角色').getAttribute('value')).toBeNull();
  expect((screen.getByLabelText('extract 角色') as HTMLSelectElement).value).toBe('');
  expect(screen.getByRole('link', { name: '前往索引维护' })).toBeTruthy();
});
