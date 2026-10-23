// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelSettingsEditor } from './ModelSettings.js';
import { IdSchema, ModelSettingsSchema } from '@tslightrag/contracts';
import { textProfile, embeddingProfile, rerankProfile, bindings } from '../../../tests/helpers/model-profiles.js';
import type { ApplicationApi } from './api/client.js';
import type { ModelSettings, SaveModels } from '@tslightrag/contracts';
import { webcrypto } from 'node:crypto';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows the input capacity left after reserving output and warns when no capacity remains', () => {
  const { apiKey, ...profile } = textProfile('http://localhost:8000/v1', { maxOutputTokens: 26384, contextTokens: 32768 }); void apiKey;
  const initial = ModelSettingsSchema.parse({ revision: 1, editingAvailable: true,
    profiles: [{ ...profile, hasApiKey: false }], bindings: { ...bindings, embedding: null, rerank: null } });
  const api: ApplicationApi = { health: vi.fn(), models: vi.fn(), saveModels: vi.fn(), testModel: vi.fn() };
  render(<ModelSettingsEditor initial={initial} api={api} onSaved={vi.fn()} />);
  expect(screen.getByText(/输入预算最多 6384 token/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('最大输出 token'), { target: { value: '32768' } });
  expect(screen.getByRole('alert').textContent).toContain('最大输出 token 必须小于上下文 token');
  fireEvent.change(screen.getByLabelText('上下文 token'), { target: { value: '65536' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/输入预算最多 32768 token/)).toBeTruthy();
});
it('edits JSON extensions, tests without saving, restores saved values and clears them explicitly', async () => {
  const extraBody = { chat_template_kwargs: { enable_thinking: false } };
  const { apiKey, ...profile } = textProfile('http://localhost:8000/v1'); void apiKey;
  const initial = ModelSettingsSchema.parse({ revision: 1, editingAvailable: true,
    profiles: [{ ...profile, hasApiKey: false }],
    bindings: { ...bindings, embedding: null, rerank: null } });
  const api: ApplicationApi = { health: vi.fn(), models: vi.fn(),
    testModel: vi.fn().mockResolvedValue({ ok: true, kind: 'text', message: '测试通过' }),
    saveModels: vi.fn().mockImplementation(async (input: SaveModels) => ModelSettingsSchema.parse({
      revision: input.expectedRevision + 1, editingAvailable: true, bindings: input.bindings,
      profiles: input.profiles.map(({ apiKey, ...p }) => ({ ...p, hasApiKey: Boolean(apiKey) })),
    })) };
  // Public profiles never contain the write-only apiKey field.
  const onSaved = vi.fn();
  render(<ModelSettingsEditor initial={initial} api={api} onSaved={onSaved} />);
  const editor = screen.getByLabelText('扩展参数（JSON 对象）');
  fireEvent.change(editor, { target: { value: JSON.stringify(extraBody, null, 2) } });
  await userEvent.click(screen.getByRole('button', { name: '测试连接（发送示例）' }));
  expect(await screen.findByText('测试通过')).toBeTruthy();
  expect(api.testModel).toHaveBeenCalledWith(expect.objectContaining({ extraBody }), 1, expect.any(AbortSignal));
  expect(api.saveModels).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect(await screen.findByText('模型配置已保存')).toBeTruthy();
  expect(vi.mocked(api.saveModels).mock.calls[0]![0].profiles[0]).toMatchObject({ extraBody });
  vi.mocked(api.models).mockResolvedValue(onSaved.mock.calls[0]![0] as ModelSettings);
  fireEvent.change(editor, { target: { value: '{unfinished' } });
  await userEvent.click(screen.getByRole('button', { name: '重新加载配置' }));
  expect(await screen.findByText('已重新加载，未保存修改已丢弃')).toBeTruthy();
  expect((editor as HTMLTextAreaElement).value).toBe(JSON.stringify(extraBody, null, 2));
  fireEvent.change(editor, { target: { value: '' } });
  await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect(await screen.findByText('模型配置已保存')).toBeTruthy();
  expect(vi.mocked(api.saveModels).mock.calls[1]![0].profiles[0]).not.toHaveProperty('extraBody');
});
it('keeps malformed drafts editable but blocks tests and saves for invalid or reserved extensions', async () => {
  const { apiKey, ...p } = textProfile('http://localhost:8000/v1'); void apiKey;
  const initial = ModelSettingsSchema.parse({ revision: 0, editingAvailable: true,
    profiles: [{ ...p, hasApiKey: false }], bindings: { ...bindings, embedding: null, rerank: null } });
  const api: ApplicationApi = { health: vi.fn(), models: vi.fn(), testModel: vi.fn(), saveModels: vi.fn() };
  render(<ModelSettingsEditor initial={initial} api={api} onSaved={vi.fn()} />);
  for (const raw of ['{unfinished', '[]', '{"max_tokens":1}']) {
    const editor = screen.getByLabelText('扩展参数（JSON 对象）');
    fireEvent.change(editor, { target: { value: raw } });
    await userEvent.click(screen.getByRole('button', { name: '测试连接（发送示例）' }));
    expect(screen.getByRole('status').textContent).toContain('扩展参数');
    await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(screen.getByRole('status').textContent).toContain('扩展参数');
    expect((editor as HTMLTextAreaElement).value).toBe(raw);
  }
  expect(api.testModel).not.toHaveBeenCalled(); expect(api.saveModels).not.toHaveBeenCalled();
});
it('adds distinct text, embedding and rerank profiles and saves bindings without crypto.randomUUID', async () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  expect(crypto.randomUUID).toBeUndefined();
  const initial = ModelSettingsSchema.parse({ profiles: [], revision: 0, editingAvailable: true,
    bindings: { query: null, extract: null, keyword: null, embedding: null, rerank: null } });
  const api: ApplicationApi = { health: vi.fn(), models: vi.fn(), testModel: vi.fn(),
    saveModels: vi.fn().mockImplementation(async (input: SaveModels) => ModelSettingsSchema.parse({
      revision: 1, editingAvailable: true, bindings: input.bindings,
      profiles: input.profiles.map(({ apiKey, ...profile }) => ({ ...profile, hasApiKey: Boolean(apiKey) })),
    })) };
  const onSaved = vi.fn();
  render(<ModelSettingsEditor initial={initial} api={api} onSaved={onSaved} />);
  for (const name of ['文本模型', '文本模型', '向量模型', '重排模型']) {
    await userEvent.click(screen.getByRole('button', { name: `添加${name}` }));
  }
  await userEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect(await screen.findByText('模型配置已保存')).toBeTruthy();
  const saved = vi.mocked(api.saveModels).mock.calls[0]![0];
  expect(saved.profiles).toHaveLength(4);
  expect(new Set(saved.profiles.map(p => p.id)).size).toBe(4);
  for (const profile of saved.profiles) expect(IdSchema.safeParse(profile.id).success).toBe(true);
  expect(saved.bindings).toMatchObject({ query: saved.profiles[0]!.id, embedding: saved.profiles[2]!.id, rerank: saved.profiles[3]!.id });
  expect(onSaved).toHaveBeenCalledOnce();
});
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
