// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphViewer } from './GraphViewer.js';
import type { GraphData } from '@tslightrag/contracts';
const graph: GraphData = { nodes: [{ id: 'a', name: '<img src=x onerror=alert(1)>', type: 'concept', description: '<script>bad()</script>', sourceCount: 1 }],
  edges: [{ id: 'broken', sourceId: 'a', targetId: 'missing', description: 'broken endpoint', keywords: [], weight: 1, sourceCount: 1 }], totalNodes: 500, totalEdges: 400, matchedNodes: 500, truncated: true, corpusRevision: 3 };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps the bounded graph usable with missing edge endpoints, renders text safely and expands real sources', async () => {
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => url.includes('/sources')
    ? { items: [], total: 0, offset: 0, corpusRevision: 3 } : graph }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<GraphViewer />);
  expect(await screen.findByText(/显示 1 \/ 500/)).toBeTruthy();
  expect(view.container.querySelector('img,script')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: graph.nodes[0]!.name }));
  expect(await screen.findByText('共 0 个来源块')).toBeTruthy();
  expect(screen.getByText('<script>bad()</script>')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '展开邻居' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('nodeId=a'))).toBe(true));
  await userEvent.type(screen.getByLabelText('实体名称'), 'Alpha');
  await userEvent.click(screen.getByRole('button', { name: '搜索图谱' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('q=Alpha'))).toBe(true));
});
it('reports source revision changes and API failures, and aborts owned requests on unmount', async () => {
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn().mockImplementation((url: string, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return Promise.resolve({ ok: true, json: async () => url.includes('/sources') ? { items: [], total: 0, offset: 0, corpusRevision: 4 } : graph });
  });
  vi.stubGlobal('fetch', fetcher); const view = render(<GraphViewer />);
  await userEvent.click(await screen.findByRole('button', { name: graph.nodes[0]!.name }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '语料已变化，请刷新图谱后查看来源。');
  fetcher.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'FAILED', message: '服务暂不可用', requestId: 'r' }) });
  await userEvent.click(screen.getByRole('button', { name: '刷新图谱' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '服务暂不可用');
  view.unmount(); expect(signals.every(signal => signal.aborted)).toBe(true);
});
