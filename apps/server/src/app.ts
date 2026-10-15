import { access } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import multipart from '@fastify/multipart';
import { ApiErrorSchema, HealthSchema, TestModelResultSchema } from '@tslightrag/contracts';
import { ModelConfigStore, boundProfile } from './models/config.js';
import { ModelClient } from './models/client.js';
import { ModelError } from './models/errors.js';
import { webDist } from './paths.js';
import type { SnapshotStore } from './storage/snapshot.js';

export async function buildApp(options: { storage: SnapshotStore; staticDir?: string }) {
  const config = await ModelConfigStore.open(options.storage.dataDir, options.storage);
  const models = new ModelClient();
  const shutdown = new AbortController();
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('preClose', async () => { shutdown.abort(); });
  app.addHook('onClose', async () => { await config.close(); });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  });
  app.addHook('onRequest', async (request, reply) => {
    const hostname = request.hostname;
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(hostname)) {
      return reply.code(403).send(ApiErrorSchema.parse({
        code: 'INVALID_HOST', message: '仅允许本机访问', requestId: request.id,
      }));
    }
    const origin = request.headers.origin;
    if ((origin && origin !== `http://${request.host}`) || request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send(ApiErrorSchema.parse({
        code: 'INVALID_ORIGIN', message: '拒绝非同源请求', requestId: request.id,
      }));
    }
  });
  app.get('/api/v1/health', async (request, reply) => {
    if (!options.storage.healthy || !config.healthy) return reply.code(503).send(ApiErrorSchema.parse({
      code: 'STORAGE_UNAVAILABLE', message: '本地存储不可用，请检查并重启', requestId: request.id,
    }));
    const snapshot = options.storage.capture();
    const captured = config.capture();
    const missingRoles = (['query', 'embedding'] as const).filter((role) => !boundProfile(captured, role));
    return HealthSchema.parse({
      status: 'ok', stage: 'S03', usable: false,
      models: { configured: missingRoles.length === 0, missingRoles },
      storage: { initialized: true, status: 'ready', generation: snapshot.generation,
        revision: snapshot.revision, corpusRevision: snapshot.corpusRevision }, jobs: { available: false },
    });
  });
  app.get('/api/v1/settings/models', async () => config.public());
  app.put('/api/v1/settings/models', async (request) => config.save(request.body));
  app.post('/api/v1/settings/models/test', async (request, reply) => {
    const candidate = config.candidate(request.body);
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on('close', onClose);
    try {
      return TestModelResultSchema.parse(await models.test(candidate, AbortSignal.any([controller.signal, shutdown.signal])));
    } finally { reply.raw.off('close', onClose); }
  });

  const root = options.staticDir ?? webDist;
  try { await access(join(root, 'index.html')); }
  catch { throw new Error('WebUI 构建产物缺失；请先执行 npm run build'); }
  await app.register(staticFiles, { root, wildcard: false, index: false });
  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/settings/models', async (_request, reply) => reply.sendFile('index.html'));
  app.setNotFoundHandler((request, reply) => reply.code(404).send(ApiErrorSchema.parse({
    code: 'NOT_FOUND', message: '接口或页面不存在', requestId: request.id,
  })));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ModelError) return reply.code(error.statusCode).send(ApiErrorSchema.parse({
      code: error.code, message: error.message, requestId: request.id,
    }));
    const candidate = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof candidate === 'number' && candidate >= 400 && candidate < 500
      ? candidate : 500;
    return reply.code(status).send(ApiErrorSchema.parse({
      code: status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
      message: status === 500 ? '服务内部错误' : '请求不合法', requestId: request.id,
    }));
  });
  return app;
}
