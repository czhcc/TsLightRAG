import { expect, it } from 'vitest';
import { ChatExtraBodySchema, ModelProfileInputSchema } from './index.js';

it('accepts nested provider JSON including false and rejects non-objects', () => {
  const extra = { chat_template_kwargs: { enable_thinking: false }, top_k: 20, stop: ['END'], custom: null };
  expect(ChatExtraBodySchema.parse(extra)).toEqual(extra);
  for (const value of [null, [], 'json', 1, false]) expect(ChatExtraBodySchema.safeParse(value).success).toBe(false);
  expect(ChatExtraBodySchema.safeParse({ custom: '中'.repeat(6000) }).success).toBe(false);
});

it.each(['model', 'messages', 'temperature', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options',
  'n', 'tools', 'tool_choice', 'functions', 'function_call'])('rejects application-controlled %s', (key) => {
  expect(ChatExtraBodySchema.safeParse({ [key]: null }).success).toBe(false);
});

it('keeps old text profiles valid and allows extensions only for text', () => {
  const profile = { id: 'text', name: 'Text', kind: 'text', protocol: 'openai-compatible',
    model: 'local', endpoint: 'http://localhost:8000/v1', timeoutMs: 30000, maxConcurrency: 2 };
  expect(ModelProfileInputSchema.parse(profile)).not.toHaveProperty('extraBody');
  expect(ModelProfileInputSchema.safeParse({ ...profile, extraBody: { chat_template_kwargs: { enable_thinking: false } } }).success).toBe(true);
  expect(ModelProfileInputSchema.safeParse({ ...profile, kind: 'embedding', dimensions: 2, operatorRevision: 0, extraBody: {} }).success).toBe(false);
});
