import { z } from 'zod';

export const IdSchema = z.string().min(1).max(128).regex(/^[\p{L}\p{N}_.:-]+$/u);
const text = z.string().trim().min(1).max(20_000);
const timestamp = z.iso.datetime();
const endpoint = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol)
    && !url.username && !url.password && !url.hash && !url.search;
}, '必须是没有凭据、query 或 fragment 的 HTTP(S) 地址');

export const ModelRoleSchema = z.enum(['query', 'extract', 'keyword', 'embedding', 'rerank']);
const profile = z.strictObject({
  id: IdSchema, name: z.string().trim().min(1).max(100), endpoint,
  model: z.string().trim().min(1).max(200),
  timeoutMs: z.number().int().min(100).max(600_000),
  maxConcurrency: z.number().int().min(1).max(32),
  maxRetries: z.number().int().min(0).max(5).default(2),
  retryBaseMs: z.number().int().min(1).max(10_000).default(200),
  maxRetryDelayMs: z.number().int().min(1).max(30_000).default(5000),
});
const textOptions = {
  kind: z.literal('text'), protocol: z.literal('openai-compatible'),
  temperature: z.number().min(0).max(2).default(0),
  maxOutputTokens: z.number().int().min(1).max(131_072).default(2048),
  contextTokens: z.number().int().min(1).max(2_000_000).default(32768),
  tokenizer: z.enum(['cl100k_base', 'o200k_base']).default('cl100k_base'),
};
const embeddingOptions = {
  kind: z.literal('embedding'), protocol: z.literal('openai-compatible'),
  dimensions: z.number().int().min(1).max(65_536),
  operatorRevision: z.number().int().nonnegative(),
  batchSize: z.number().int().min(1).max(256).default(32),
};
const rerankOptions = {
  kind: z.literal('rerank'), protocol: z.enum(['cohere-compatible', 'jina-compatible']),
  enabled: z.boolean().default(true), topN: z.number().int().min(1).max(200).default(10),
  failurePolicy: z.enum(['fail', 'fallback-with-warning']).default('fail'),
};
export const ModelProfileSchema = z.discriminatedUnion('kind', [
  profile.extend({ ...textOptions, hasApiKey: z.boolean() }),
  profile.extend({ ...embeddingOptions, hasApiKey: z.boolean() }),
  profile.extend({ ...rerankOptions, hasApiKey: z.boolean() }),
]);
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
// This write-only field never appears in public GET responses.
const secret = { apiKey: z.string().min(1).max(4096).refine((s) => !/[\r\n]/.test(s) && !/^\*+$/.test(s)).nullable().optional() };
export const ModelProfileInputSchema = z.discriminatedUnion('kind', [
  profile.extend({ ...textOptions, ...secret }),
  profile.extend({ ...embeddingOptions, ...secret }),
  profile.extend({ ...rerankOptions, ...secret }),
]);
export type ModelProfileInput = z.infer<typeof ModelProfileInputSchema>;
export const ModelBindingsSchema = z.strictObject({
  query: IdSchema.nullable(), extract: IdSchema.nullable(), keyword: IdSchema.nullable(),
  embedding: IdSchema.nullable(), rerank: IdSchema.nullable(),
});
function validateBindings(value: { profiles: { id: string; kind: string }[]; bindings: z.infer<typeof ModelBindingsSchema> }, ctx: z.RefinementCtx) {
  const profiles = new Map(value.profiles.map((item) => [item.id, item]));
  if (profiles.size !== value.profiles.length) ctx.addIssue({ code: 'custom', path: ['profiles'], message: '模型 ID 不能重复' });
  for (const [role, id] of Object.entries(value.bindings)) {
    if (id === null) continue;
    const kind = ['embedding', 'rerank'].includes(role) ? role : 'text';
    if (profiles.get(id)?.kind !== kind) ctx.addIssue({ code: 'custom', path: ['bindings', role], message: '绑定不存在或类型不匹配' });
  }
}
export const ModelSettingsSchema = z.strictObject({
  revision: z.number().int().nonnegative(), profiles: z.array(ModelProfileSchema).max(100),
  bindings: ModelBindingsSchema, editingAvailable: z.boolean(),
  embeddingSpaceId: z.string().nullable().optional(),
}).superRefine(validateBindings);
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
export const SaveModelsSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  profiles: z.array(ModelProfileInputSchema).max(100), bindings: ModelBindingsSchema,
}).superRefine(validateBindings);
export type SaveModels = z.infer<typeof SaveModelsSchema>;
export const TestModelSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(), profile: ModelProfileInputSchema,
});
export const TestModelResultSchema = z.strictObject({
  ok: z.literal(true), kind: z.enum(['text', 'embedding', 'rerank']),
  message: z.string(), dimensions: z.number().int().positive().optional(),
});

export const DocumentStatusSchema = z.enum([
  'queued', 'parsing', 'chunking', 'extracting', 'embedding', 'committing',
  'processed', 'failed', 'cancelled', 'awaiting_configuration', 'interrupted',
]);
export const DocumentSchema = z.strictObject({
  id: IdSchema, name: z.string().min(1).max(255), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(), status: DocumentStatusSchema,
  createdAt: timestamp, updatedAt: timestamp,
});
export const JobSchema = z.strictObject({
  id: IdSchema, documentId: IdSchema.nullable(),
  operation: z.enum(['index', 'delete', 'reindex', 'rebuild']),
  status: DocumentStatusSchema, attempt: z.number().int().positive(),
  configRevision: z.number().int().nonnegative(), cancelRequested: z.boolean(),
  error: z.string().max(2000).nullable(), updatedAt: timestamp,
});
export const EntitySchema = z.strictObject({
  id: IdSchema, name: z.string().trim().min(1).max(500), type: z.string().min(1).max(100),
  description: text, sourceChunkIds: z.array(IdSchema).min(1).max(10_000),
});
export const RelationSchema = z.strictObject({
  id: IdSchema, sourceId: IdSchema, targetId: IdSchema, description: text,
  keywords: z.array(z.string().min(1).max(200)).max(100),
  weight: z.number().finite().nonnegative(), sourceChunkIds: z.array(IdSchema).min(1).max(10_000),
});
export const QueryModeSchema = z.enum(['naive', 'local', 'global', 'hybrid', 'mix']);
export const QuerySchema = z.strictObject({
  query: text, mode: QueryModeSchema.default('mix'),
  topK: z.number().int().min(1).max(200).default(40),
  chunkTopK: z.number().int().min(1).max(200).default(20),
  maxTotalTokens: z.number().int().min(1).max(1_000_000).default(16_000),
  enableRerank: z.boolean().default(false),
  kgChunkPickMethod: z.enum(['VECTOR', 'WEIGHT']).default('VECTOR'),
  relatedChunkNumber: z.number().int().min(0).max(100).default(5),
  conversationHistory: z.array(z.strictObject({
    role: z.enum(['user', 'assistant']), content: text,
  })).max(100).default([]),
  userPrompt: z.string().max(20_000).optional(),
  onlyNeedContext: z.boolean().default(false), onlyNeedPrompt: z.boolean().default(false),
}).refine((value) => !(value.onlyNeedContext && value.onlyNeedPrompt), {
  message: '上下文与提示词调试选项不能同时开启',
});
export type Query = z.infer<typeof QuerySchema>;

export const CitationSchema = z.strictObject({
  id: IdSchema, documentId: IdSchema, fileName: z.string().min(1).max(255),
  chunkIds: z.array(IdSchema).min(1).max(1000),
  location: z.string().max(500).optional(), content: z.string().max(100_000).optional(),
});
export const ApiErrorSchema = z.strictObject({
  code: z.string().min(1).max(100), message: z.string().min(1).max(2000),
  requestId: z.string().min(1).max(200),
});
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('meta'), requestId: IdSchema, mode: QueryModeSchema }),
  z.strictObject({ type: z.literal('references'), references: z.array(CitationSchema).max(1000) }),
  z.strictObject({ type: z.literal('delta'), text: z.string().max(100_000) }),
  z.strictObject({ type: z.literal('done'), finishReason: z.enum(['stop', 'length']), warnings: z.array(z.string()).max(100) }),
  z.strictObject({ type: z.literal('error'), error: ApiErrorSchema }),
  z.strictObject({ type: z.literal('cancelled') }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const HealthSchema = z.strictObject({
  status: z.literal('ok'), stage: z.literal('S04'), usable: z.literal(false),
  models: z.strictObject({ configured: z.boolean(), missingRoles: z.array(ModelRoleSchema) }),
  storage: z.strictObject({ initialized: z.literal(true), status: z.literal('ready'),
    generation: z.string().min(1), revision: z.number().int().nonnegative(), corpusRevision: z.number().int().nonnegative() }),
  jobs: z.strictObject({ available: z.literal(false) }),
});
export type Health = z.infer<typeof HealthSchema>;

export * from './parsing.js';
