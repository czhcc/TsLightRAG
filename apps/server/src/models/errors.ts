export class ModelError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 502) { super(message); }
}
export function invalid(detail?: string) { return new ModelError('INVALID_MODEL_RESPONSE', detail ?? '模型返回的数据格式不合法'); }
