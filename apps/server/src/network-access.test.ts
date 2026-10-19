import { expect, it } from 'vitest';
import { allowsRequestHost } from './network-access.js';

it('keeps default loopback isolation and rejects DNS names under wildcard binding', () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) expect(allowsRequestHost(host)).toBe(true);
  expect(allowsRequestHost('192.168.1.20')).toBe(false);
  for (const host of ['evil.example', '192.168.1.20.evil.example', 'localhost.evil.example']) {
    expect(allowsRequestHost(host, '0.0.0.0')).toBe(false);
  }
});

it('allows numeric IPv4/IPv6 on explicit wildcard binding and respects specific addresses', () => {
  expect(allowsRequestHost('192.168.1.20', '0.0.0.0')).toBe(true);
  expect(allowsRequestHost('[2001:db8::20]', '::')).toBe(true);
  expect(allowsRequestHost('192.168.1.20', '192.168.1.20')).toBe(true);
  expect(allowsRequestHost('192.168.1.21', '192.168.1.20')).toBe(false);
  expect(allowsRequestHost('[2001:db8::20]', '2001:db8:0:0:0:0:0:20')).toBe(true);
});
