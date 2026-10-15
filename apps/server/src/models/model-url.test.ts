import { expect, it } from 'vitest';
import { assertAddress, modelUrl, resolveModel } from './url.js';
import { retryAfter } from './http.js';
it.each([
  ['https://host/v1', 'https://host/v1/chat/completions'],
  ['https://host/proxy/api/v1/', 'https://host/proxy/api/v1/chat/completions'],
  ['https://host', 'https://host/chat/completions'],
])('preserves base prefix %s', (input, expected) => { expect(modelUrl(input, 'text').href).toBe(expected); });
it('appends embeddings only and preserves the complete rerank endpoint', () => {
  expect(modelUrl('https://host/proxy/v1/', 'embedding').pathname).toBe('/proxy/v1/embeddings');
  expect(modelUrl('https://host/custom/rerank/', 'rerank').href).toBe('https://host/custom/rerank/');
});
it.each(['file:///tmp/key', 'ftp://host', 'https://user:secret@host/v1', 'https://host?key=x', 'https://host/#fragment',
  'http://169.254.169.254/v1', 'http://2852039166', 'http://0xa9fea9fe', 'http://[fe80::1]/',
  'http://[::ffff:169.254.169.254]', 'http://metadata.google.internal/v1', 'http://metadata/v1', 'http://0.0.0.0'])('rejects unsafe endpoint %s', (url) => {
  expect(() => modelUrl(url, 'text')).toThrow();
});
it('supports explicit loopback/LAN and rejects forbidden DNS answers', async () => {
  for (const address of ['127.0.0.1', '::1', '192.168.1.12', '10.0.0.4']) expect(() => assertAddress(address)).not.toThrow();
  for (const address of ['169.254.170.2', 'fe80::a', '::ffff:a9fe:a9fe', '::', '224.0.0.2']) expect(() => assertAddress(address)).toThrow();
  expect(await resolveModel('127.0.0.1')).toEqual([{ address: '127.0.0.1', family: 4 }]);
});
it('bounds numeric/date Retry-After and handles malformed values', () => {
  expect(retryAfter('999', 30)).toBe(30); expect(retryAfter('bad', 30)).toBe(0);
  expect(retryAfter(new Date(5000).toUTCString(), 10000, 2000)).toBe(3000);
});
