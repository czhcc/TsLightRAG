import { ApiErrorSchema, HealthSchema, ModelSettingsSchema, TestModelResultSchema } from '@tslightrag/contracts';
import type { Health, ModelSettings, SaveModels, ModelProfileInput } from '@tslightrag/contracts';
import type { z } from 'zod';

export interface ApplicationApi {
  health(signal: AbortSignal): Promise<Health>;
  models(signal: AbortSignal): Promise<ModelSettings>;
  saveModels(input: SaveModels, signal: AbortSignal): Promise<ModelSettings>;
  testModel(profile: ModelProfileInput, expectedRevision: number, signal: AbortSignal): Promise<z.infer<typeof TestModelResultSchema>>;
}
async function call(path: string, signal: AbortSignal, method?: 'PUT' | 'POST', body?: unknown): Promise<unknown> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json', ...(method ? { 'Content-Type': 'application/json' } : {}) },
    ...(method ? { method, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    let message = `请求失败（HTTP ${String(response.status)}）`;
    try { const parsed = ApiErrorSchema.safeParse(await response.json()); if (parsed.success) message += `：${parsed.data.message}`; } catch { /* never expose an untrusted body */ }
    throw new Error(message);
  }
  return response.json();
}
export const applicationApi: ApplicationApi = {
  health: async (signal) => HealthSchema.parse(await call('/api/v1/health', signal)),
  models: async (signal) => ModelSettingsSchema.parse(await call('/api/v1/settings/models', signal)),
  saveModels: async (input, signal) => ModelSettingsSchema.parse(await call('/api/v1/settings/models', signal, 'PUT', input)),
  testModel: async (profile, expectedRevision, signal) => TestModelResultSchema.parse(await call('/api/v1/settings/models/test', signal, 'POST', { profile, expectedRevision })),
};
