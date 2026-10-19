import { request } from 'node:http';
import { expect, it } from 'vitest';
import { startService } from '../helpers/owned-service.js';
import { networkInterfaces } from 'node:os';

async function get(address: string, host: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const outgoing = request(`${address}/api/v1/health`, { headers: { Host: host, ...extra } }, response => {
      let body = ''; response.on('data', chunk => { body += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    outgoing.on('error', reject); outgoing.end();
  });
}

it('serves IP Hosts under wildcard binding while retaining Origin and DNS-host protection', async () => {
  const service = await startService(['--host', '0.0.0.0']);
  const port = new URL(service.address).port; const address = `http://127.0.0.1:${port}`;
  const host = `192.168.1.20:${port}`;
  try {
    const allowed = await get(address, host, { Origin: `http://${host}` });
    expect(allowed.status).toBe(200); expect(JSON.parse(allowed.body).status).toBe('ok');
    expect((await get(address, host)).status).toBe(200);
    expect((await get(address, host, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await get(address, host, { Origin: `http://${host}`, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await get(address, `evil.example:${port}`)).status).toBe(403);
    expect((await get(address, `192.168.1.20.evil.example:${port}`)).status).toBe(403);
    expect((await fetch(`${address}/settings/models`)).status).toBe(200);
    const ip = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
    if (ip) {
      const direct = await get(`http://${ip}:${port}`, `${ip}:${port}`, { Origin: `http://${ip}:${port}` });
      expect(direct.status).toBe(200); expect(JSON.parse(direct.body).status).toBe('ok');
    }
  } finally { await service.stop(); }
});

it('retains loopback-only request Host validation by default', async () => {
  const service = await startService();
  try { expect((await get(service.address, '192.168.1.20:9621')).status).toBe(403); }
  finally { await service.stop(); }
});
