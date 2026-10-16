import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { ApiErrorSchema, HealthSchema, ModelSettingsSchema } from '@tslightrag/contracts';
import { startService } from '../helpers/owned-service.js';

describe('real executable server without inherited environment', () => {
  let service: Awaited<ReturnType<typeof startService>>;
  beforeAll(async () => { service = await startService(); });
  afterAll(async () => { if (service) expect(await service.stop()).toBe(0); });
  it('distinguishes a live process from a ready knowledge base', async () => {
    const response = await fetch(`${service.address}/api/v1/health`);
    expect(response.status).toBe(200);
    const health = HealthSchema.parse(await response.json());
    expect(health).toMatchObject({ status: 'ok', usable: false, stage: 'S07', storage: { initialized: true } });
    expect(health.models.missingRoles).toEqual(['query', 'embedding']);
  });
  it('serves explicit empty, editable model configuration', async () => {
    const response = await fetch(`${service.address}/api/v1/settings/models`);
    const settings = ModelSettingsSchema.parse(await response.json());
    expect(settings.profiles).toEqual([]);
    expect(settings.editingAvailable).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('apiKey');
  });
  it.each(['/', '/settings/models'])('serves the built application at %s', async (path) => {
    const response = await fetch(`${service.address}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="root"></div>');
  });
  it('serves hashed assets with JavaScript MIME', async () => {
    const html = await (await fetch(service.address)).text();
    const script = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeTruthy();
    const response = await fetch(new URL(script ?? '/missing', service.address));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect((await response.text()).length).toBeGreaterThan(100);
  });
  it.each(['/api/v1/missing', '/assets/missing.js', '/missing-page'])('returns JSON 404 instead of SPA HTML for %s', async (path) => {
    const response = await fetch(`${service.address}${path}`);
    expect(response.status).toBe(404);
    expect(ApiErrorSchema.parse(await response.json()).code).toBe('NOT_FOUND');
  });
  it('rejects unsupported POST to model settings', async () => {
    for (const path of ['/api/v1/settings/models']) {
      const response = await fetch(`${service.address}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(404);
    }
  });
  it('rejects foreign Origin and hostile Host', async () => {
    const foreign = await fetch(`${service.address}/api/v1/settings/models`, { headers: { Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect(ApiErrorSchema.parse(await foreign.json()).code).toBe('INVALID_ORIGIN');
    // Fetch controls Host itself; node:http is needed to put the hostile value on the wire.
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(`${service.address}/api/v1/health`, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        response.on('end', () => { resolve(response.statusCode); });
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(hostStatus).toBe(403);
  });
  it('accepts the exact same Origin and sets defensive response headers', async () => {
    const response = await fetch(`${service.address}/api/v1/health`, { headers: { Origin: service.address } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

it('ignores business environment variable overrides', async () => {
  const service = await startService([], { HOST: '0.0.0.0', PORT: '1', OPENAI_API_KEY: 'fixture-not-a-real-key' });
  try {
    expect(service.address).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(HealthSchema.parse(await (await fetch(`${service.address}/api/v1/health`)).json()).models.configured).toBe(false);
  } finally { expect(await service.stop()).toBe(0); }
});
