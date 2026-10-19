import { isIP } from 'node:net';

const address = (host: string) => host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
const canonical = (host: string) => isIP(host) === 6 ? new URL(`http://[${host}]`).hostname : host;

export function allowsRequestHost(hostname: string, listenHost = '127.0.0.1') {
  const host = address(hostname.toLowerCase());
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
  if (!isIP(host) || host.includes('%')) return false;
  // Explicit wildcard binding permits IP-based access (including NAT IPs),
  // while arbitrary DNS names remain rejected to prevent DNS rebinding.
  if (listenHost === '0.0.0.0' || listenHost === '::') return true;
  return canonical(host) === canonical(listenHost);
}
