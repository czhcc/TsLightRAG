import { HealthSchema, ModelSettingsSchema } from '@tslightrag/contracts';
import type { Health, ModelSettings } from '@tslightrag/contracts';

export interface ApplicationApi {
  health(signal: AbortSignal): Promise<Health>;
  models(signal: AbortSignal): Promise<ModelSettings>;
}
async function get(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`请求失败（HTTP ${String(response.status)}）`);
  return response.json();
}
export const applicationApi: ApplicationApi = {
  health: async (signal) => HealthSchema.parse(await get('/api/v1/health', signal)),
  models: async (signal) => ModelSettingsSchema.parse(await get('/api/v1/settings/models', signal)),
};
