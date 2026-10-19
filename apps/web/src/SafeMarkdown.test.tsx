// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SafeMarkdown } from './SafeMarkdown.js';
afterEach(cleanup);
it('renders Markdown while dropping raw HTML, dangerous URLs and all image loads', () => {
  const view = render(<SafeMarkdown content={'## 回答\n\n**证据** [1]\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[坏链接](javascript:alert%281%29) [文档](https://example.com) ![远程图](https://example.com/a.png)'} />);
  expect(screen.getByRole('heading', { name: '回答' })).toBeTruthy();
  expect(view.container.querySelector('strong')?.textContent).toBe('证据');
  expect(view.container.querySelector('script,img')).toBeNull();
  expect(screen.queryByRole('link', { name: '坏链接' })).toBeNull();
  expect(screen.getByRole('link', { name: '文档' }).getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.getByText('[图片：远程图]')).toBeTruthy();
});
