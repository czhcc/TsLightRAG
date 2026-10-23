import { expect, it } from 'vitest';
import { ConversationSchema, ChatMessageRequestSchema, ChatSettingsSchema } from './index.js';
const settings = ChatSettingsSchema.parse({});
const turn = { id: 'turn', question: 'question', answer: '', status: 'generating', createdAt: '2026-10-23T00:00:00Z', settings, references: [], warnings: [] };
const conversation = { id: 'conversation', title: '新对话', revision: 0, createdAt: turn.createdAt, updatedAt: turn.createdAt, settings, turns: [turn] };
it('validates histories and rejects duplicate turns or a generating turn before the last one', () => {
  expect(ConversationSchema.safeParse(conversation).success).toBe(true);
  expect(ConversationSchema.safeParse({ ...conversation, turns: [turn, turn] }).success).toBe(false);
  expect(ConversationSchema.safeParse({ ...conversation, turns: [turn, { ...turn, id: 'other', status: 'completed' }] }).success).toBe(false);
});
it('validates chat questions, concurrency revisions and retrieval options without accepting client-supplied history', () => {
  const request = { expectedRevision: 0, question: 'follow up', settings };
  expect(ChatMessageRequestSchema.safeParse(request).success).toBe(true);
  for (const patch of [{ expectedRevision: -1 }, { question: ' ' }, { settings: { ...settings, mode: 'invalid' } },
    { settings: { ...settings, relatedChunkNumber: 101 } }, { conversationHistory: [] }]) {
    expect(ChatMessageRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  }
});
