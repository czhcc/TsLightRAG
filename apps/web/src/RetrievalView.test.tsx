// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryPreview } from './QueryPreview.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('streams Markdown, retains partial answers on errors and submits actual mode/rerank options', async () => {
  const events = [{ type: 'meta', requestId: 'r', mode: 'global' },
    { type: 'references', references: [{ id: '1', documentId: 'd', fileName: '证据.txt', chunkIds: ['c'], content: '<script>bad()</script>' }] },
    { type: 'delta', text: '**部分回答** [1]' }, { type: 'error', error: { code: 'FAILED', message: '模型断流', requestId: 'r' } }];
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(events.map(e => JSON.stringify(e)).join('\n') + '\n')));
  vi.stubGlobal('fetch', fetcher); render(<QueryPreview />);
  await userEvent.type(screen.getByLabelText('检索问题'), '协作');
  await userEvent.selectOptions(screen.getByLabelText('检索模式'), 'global');
  await userEvent.click(screen.getByLabelText('启用重排'));
  await userEvent.click(screen.getByRole('button', { name: '生成回答' }));
  const answer = await screen.findByRole('region', { name: '知识库回答' });
  expect(await within(answer).findByText('回答失败；已显示的内容可能不完整')).toBeTruthy();
  expect(within(answer).getByText('部分回答').tagName).toBe('STRONG');
  expect(screen.getByRole('alert').textContent).toBe('模型断流');
  expect(JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ mode: 'global', enableRerank: true });
  await userEvent.click(screen.getByText('[1] 证据.txt'));
  expect(within(answer).getByText('<script>bad()</script>')).toBeTruthy();
  expect(within(answer).getByRole('link', { name: '查看来源文档' }).getAttribute('href')).toBe('/documents?id=d');
});
