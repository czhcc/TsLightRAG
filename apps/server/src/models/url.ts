import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ModelError } from './errors.js';

const blocked = new BlockList();
blocked.addAddress('fd00:ec2::254', 'ipv6');
blocked.addAddress('100.100.100.200', 'ipv4');
for (const [ip, prefix] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['::', 128], ['fe80::', 10], ['ff00::', 8], ['fec0::', 10]] as const) blocked.addSubnet(ip, prefix, 'ipv6');
export function assertAddress(address: string) {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) throw new ModelError('INVALID_MODEL_URL', '不允许的模型网络地址', 400);
}
export function modelUrl(endpoint: string, kind: 'text' | 'embedding' | 'rerank') {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ModelError('INVALID_MODEL_URL', '模型地址不合法', 400); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search
      || ['metadata.google.internal', 'metadata', 'instance-data'].includes(hostname) || hostname.endsWith('.metadata.google.internal')) {
    throw new ModelError('INVALID_MODEL_URL', '模型地址不合法', 400);
  }
  if (isIP(hostname)) assertAddress(hostname);
  if (kind !== 'rerank') url.pathname = `${url.pathname.replace(/\/+$/, '')}/${kind === 'text' ? 'chat/completions' : 'embeddings'}`;
  return url;
}
// Resolution is performed for every new connection; the validated address is pinned
// to that connection while the original hostname remains available to TLS verification.
export async function resolveModel(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new ModelError('MODEL_NETWORK', '模型地址无法解析');
  for (const item of addresses) assertAddress(item.address);
  return addresses;
}
