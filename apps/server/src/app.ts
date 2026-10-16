import { GenerationService } from './generation/service.js';
import { NdjsonWriter } from './generation/ndjson.js';
import { QueryService } from './retrieval/service.js';
import { z } from 'zod';
import { DocumentService } from './documents/service.js';
import type { DocumentServiceOptions } from './documents/service.js';
import { DocumentError } from './documents/files.js';
import { ParserError } from './parsers/common.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import multipart from '@fastify/multipart';
import { ApiErrorSchema, HealthSchema, TestModelResultSchema, PARSER_CAPABILITIES, RetryDocumentSchema, QuerySchema } from '@tslightrag/contracts';
import { ModelConfigStore, boundProfile } from './models/config.js';
import { ModelClient } from './models/client.js';
import { ModelError } from './models/errors.js';
import { webDist } from './paths.js';
import { PublishedCommitError } from './storage/snapshot.js';
import type { SnapshotStore } from './storage/snapshot.js';

export async function buildApp(options: { storage: SnapshotStore; staticDir?: string; documentOptions?: DocumentServiceOptions }) {
  const models = new ModelClient();
  const config = await ModelConfigStore.open(options.storage.dataDir, options.storage);
  const documents = await DocumentService.open(options.storage, config, {...options.documentOptions,client:models});
  const queries = new QueryService(options.storage, config, models);
  const generation = new GenerationService(queries,models);
  const activeQueries = new Map<string,AbortController>();
  const shutdown = new AbortController();
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 30_000, connectionTimeout: 30_000, forceCloseConnections: true });
  app.addHook('preClose', async () => { shutdown.abort(); await documents.close(); });
  app.addHook('onClose', async () => { await config.close(); });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0, parts: 1 }, preservePath: true });
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
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PublishedCommitError) return reply.code(503).send(ApiErrorSchema.parse({ code: 'STORAGE_PUBLISHED_UNCERTAIN', message: '记录已发布但存储被隔离；请检查并重启，勿盲目重放', requestId: request.id }));
    if (error instanceof ParserError) return reply.code(400).send(ApiErrorSchema.parse({ code: error.code, message: error.message, requestId: request.id }));
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
  app.get('/api/v1/health', async (request, reply) => {
    if (!options.storage.healthy || !config.healthy || !documents.healthy) return reply.code(503).send(ApiErrorSchema.parse({
      code: 'STORAGE_UNAVAILABLE', message: '本地存储不可用，请检查并重启', requestId: request.id,
    }));
    const snapshot = options.storage.capture();
    const captured = config.capture();
    const missingRoles = (['query', 'embedding'] as const).filter((role) => !boundProfile(captured, role));
    return HealthSchema.parse({
      status: 'ok', stage: 'S09', usable: missingRoles.length === 0,
      models: { configured: missingRoles.length === 0, missingRoles },
      storage: { initialized: true, status: 'ready', generation: snapshot.generation,
        revision: snapshot.revision, corpusRevision: snapshot.corpusRevision }, jobs: { available: true },
    });
  });
  app.get('/api/v1/parsers/capabilities', async () => PARSER_CAPABILITIES);
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

  app.post('/api/v1/query/data', async (request, reply) => {
    const controller=new AbortController();
    const onClose=()=>{if(!reply.raw.writableFinished)controller.abort();};
    reply.raw.on('close',onClose);
    try{return await queries.data(request.body,AbortSignal.any([controller.signal,shutdown.signal]));}
    finally{reply.raw.off('close',onClose);}
  });

  app.post('/api/v1/query',async(request,reply)=>{
    const controller=new AbortController();const signal=AbortSignal.any([controller.signal,shutdown.signal]);
    const close=()=>{if(!reply.raw.writableFinished)controller.abort();};reply.raw.on('close',close);
    try{
      await generation.answer(request.body,{requestId:request.id,signal,deliver:async result=>{
        await new Promise<void>((resolve,reject)=>{
          const finished=()=>{cleanup();resolve();};const closed=()=>{cleanup();reject(new ModelError('MODEL_CANCELLED','连接已关闭',499));};
          const cleanup=()=>{reply.raw.off('finish',finished);reply.raw.off('close',closed);};
          reply.raw.once('finish',finished);reply.raw.once('close',closed);reply.send(result);
        });
      }});return reply;
    }catch(error){if(!reply.sent)throw error;return reply;}
    finally{reply.raw.off('close',close);}
  });
  app.post('/api/v1/query/stream',async(request,reply)=>{
    if(!QuerySchema.safeParse(request.body).success)throw new ModelError('INVALID_QUERY','查询参数不合法',400);
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,shutdown.signal]);
    activeQueries.set(request.id,controller);
    const close=()=>{if(!reply.raw.writableFinished)controller.abort();};reply.raw.on('close',close);
    reply.hijack();
    reply.raw.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; frame-ancestors 'none'"});
    const writer=new NdjsonWriter(reply.raw,signal);
    try{await generation.answer(request.body,{requestId:request.id,signal,emit:async event=>writer.send(event)});}
    finally{activeQueries.delete(request.id);reply.raw.off('close',close);if(!reply.raw.writableEnded&&!reply.raw.destroyed)reply.raw.end();}
  });
  app.post<{Params:{id:string}}>('/api/v1/query/:id/cancel',async request=>{
    const controller=activeQueries.get(request.params.id);controller?.abort();return {cancelled:Boolean(controller)};
  });

  let receiving = 0;
  app.post('/api/v1/documents', async (request, reply) => {
    if (receiving >= 2) throw new DocumentError('UPLOAD_BUSY', '上传通道已满，请稍后重试', 429);
    receiving++;
    try {
      if (!request.isMultipart()) throw new DocumentError('MULTIPART_REQUIRED', '文件导入需要 multipart 表单', 400);
      let bytes: Buffer | undefined; let name = '';
      for await (const part of request.parts()) {
        if (part.type !== 'file' || bytes) throw new DocumentError('INVALID_UPLOAD', '只接受一个文件', 400);
        name = part.filename; bytes = await part.toBuffer();
        if (part.file.truncated) throw new DocumentError('DOCUMENT_LIMIT', '文件超过 20 MiB', 413);
      }
      if (!bytes) throw new DocumentError('INVALID_UPLOAD', '缺少文件', 400);
      const result = await documents.importBytes(bytes, name);
      return reply.code(result.deduplicated ? 200 : 202).send(result);
    } finally { receiving--; }
  });
  app.post('/api/v1/documents/text', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const result = await documents.importText(request.body); return reply.code(result.deduplicated ? 200 : 202).send(result);
  });
  app.get('/api/v1/documents', async (request) => {
    const parsed = z.strictObject({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(request.query);
    if (!parsed.success) throw new DocumentError('INVALID_PAGINATION', '分页参数不合法', 400);
    return documents.list(parsed.data.offset, parsed.data.limit);
  });
  app.get<{ Params: { id: string } }>('/api/v1/documents/:id', async (request) => documents.detail(request.params.id));
  app.get<{ Params: { id: string } }>('/api/v1/documents/:id/parsed', async (request) => documents.parsed(request.params.id));
  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (request) => documents.job(request.params.id));
  app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/cancel', async (request) => documents.cancel(request.params.id));
  app.post<{ Params: { id: string } }>('/api/v1/documents/:id/retry', async (request, reply) => {
    const parsed = RetryDocumentSchema.safeParse(request.body);
    if (!parsed.success) throw new DocumentError('INVALID_RETRY', '重试必须提供 expectedJobId', 400);
    const result = await documents.retry(request.params.id, parsed.data.expectedJobId);
    return reply.code(result.deduplicated ? 200 : 202).send(result);
  });

  app.get('/api/v1/maintenance',async()=>documents.maintenanceState());
  app.post('/api/v1/maintenance/cleanup',async()=>documents.retryCleanup());
  app.post('/api/v1/maintenance/rebuild',async(request,reply)=>reply.code(202).send(await documents.requestMaintenance('rebuild',null,request.body)));
  app.delete('/api/v1/documents',async(request,reply)=>reply.code(202).send(await documents.requestMaintenance('delete',null,request.body)));
  app.delete<{Params:{id:string}}>('/api/v1/documents/:id',async(request,reply)=>reply.code(202).send(await documents.requestMaintenance('delete',request.params.id,request.body)));
  app.post<{Params:{id:string}}>('/api/v1/documents/:id/reindex',{bodyLimit:8*1024*1024},async(request,reply)=>reply.code(202).send(await documents.requestMaintenance('reindex',request.params.id,request.body)));
  app.post<{Params:{id:string}}>('/api/v1/jobs/:id/retry',async(request,reply)=>reply.code(202).send(await documents.retryMaintenance(request.params.id,request.body)));

  const root = options.staticDir ?? webDist;
  try { await access(join(root, 'index.html')); }
  catch { throw new Error('WebUI 构建产物缺失；请先执行 npm run build'); }
  await app.register(staticFiles, { root, wildcard: false, index: false });
  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/query', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/documents', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/settings/models', async (_request, reply) => reply.sendFile('index.html'));
  app.setNotFoundHandler((request, reply) => reply.code(404).send(ApiErrorSchema.parse({
    code: 'NOT_FOUND', message: '接口或页面不存在', requestId: request.id,
  })));

  return app;
}
