import { expect, it } from 'vitest';
import { ChatSettingsSchema, ConversationSchema, ConversationListSchema } from '@tslightrag/contracts';
import { generationHarness, generationPost, collect, generationHandler, isGeneration, sseDelta, readUntil } from '../helpers/generation.js';
import { SnapshotStore } from '../../apps/server/src/storage/snapshot.js';
import { buildApp } from '../../apps/server/src/app.js';
import { textProfile, embeddingProfile, bindings } from '../helpers/model-profiles.js';

const settings = ChatSettingsSchema.parse({ mode: 'naive', kgChunkPickMethod: 'WEIGHT', relatedChunkNumber: 7 });
async function create(h: Awaited<ReturnType<typeof generationHarness>>) {
  const response = await h.app.inject({ method: 'POST', url: '/api/v1/conversations', payload: {} });
  expect(response.statusCode, response.body).toBe(201); return ConversationSchema.parse(response.json());
}
async function get(h: Awaited<ReturnType<typeof generationHarness>>, id: string) {
  const response = await h.app.inject({ method: 'GET', url: `/api/v1/conversations/${id}` });
  expect(response.statusCode, response.body).toBe(200); return ConversationSchema.parse(response.json());
}
async function ask(h: Awaited<ReturnType<typeof generationHarness>>, c: Awaited<ReturnType<typeof create>>, question: string) {
  const response = await generationPost(h, `/api/v1/conversations/${c.id}/messages`, { expectedRevision: c.revision, question, settings });
  expect(response.status).toBe(200); const frames = await collect(response);
  expect(frames.some(e => e.type === 'error')).toBe(false); expect(frames.at(-1)?.type).toBe('done');
  return get(h, c.id);
}

it('persists separate conversations, exact follow-up history, settings and citations across restart without changing the corpus', async () => {
  const h = await generationHarness();
  try {
    const corpus = h.storage.capture().corpusRevision;
    const first = await create(h), other = await create(h);
    const answered = await ask(h, first, 'Alpha 如何协作？');
    expect(answered.title).toBe('Alpha 如何协作？'); expect(answered.settings).toEqual(settings);
    expect(answered.turns[0]).toMatchObject({ status: 'completed', answer: 'Alpha 与 Beta 协作 [1]。', finishReason: 'stop' });
    expect(answered.turns[0]?.references).toHaveLength(1);
    const followup = await ask(h, answered, '继续解释刚才的合作。');
    const bodies = h.model.requests.filter(isGeneration).map(r => r.body as { messages: { role: string; content: string }[] });
    expect(bodies[1]?.messages.slice(1)).toEqual([
      { role: 'user', content: answered.turns[0]!.question }, { role: 'assistant', content: answered.turns[0]!.answer },
      { role: 'user', content: '继续解释刚才的合作。' },
    ]);
    expect((await get(h, other.id)).turns).toEqual([]);
    const stale = await h.app.inject({ method: 'POST', url: `/api/v1/conversations/${first.id}/messages`, payload: { expectedRevision: 0, question: 'duplicate', settings } });
    expect(stale.statusCode).toBe(409); expect((await get(h, first.id)).turns).toHaveLength(2);
    const list = ConversationListSchema.parse((await h.app.inject('/api/v1/conversations')).json());
    expect(list[0]?.id).toBe(first.id); expect(list[0]).not.toHaveProperty('turns');
    expect(h.storage.capture().corpusRevision).toBe(corpus);
    await h.app.close(); await h.storage.close();
    const storage = await SnapshotStore.open(h.directory.path), app = await buildApp({ storage });
    try {
      expect((await app.inject(`/api/v1/conversations/${first.id}`)).json()).toEqual(followup);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${first.id}` })).statusCode).toBe(204);
      expect((await app.inject(`/api/v1/conversations/${first.id}`)).statusCode).toBe(404);
      expect(ConversationListSchema.parse((await app.inject('/api/v1/conversations')).json()).map(c => c.id)).toEqual([other.id]);
      expect(storage.capture().corpusRevision).toBe(corpus);
    } finally { await app.close(); await storage.close(); }
  } finally { await h.close(); }
});

it('cancels a partial answer, rejects concurrent writes, and excludes incomplete answers from follow-up history', async () => {
  let slow = true;
  const h = await generationHarness((request, response) => {
    if (slow && isGeneration(request)) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sseDelta('尚未完成的回答')); }
    else generationHandler(request, response);
  });
  try {
    const c = await create(h);
    const response = await generationPost(h, `/api/v1/conversations/${c.id}/messages`, { expectedRevision: 0, question: 'Alpha?', settings });
    const cursor = await readUntil(response, event => event.type === 'delta');
    expect(cursor.seen.some(e => e.type === 'delta')).toBe(true);
    const pending = await get(h, c.id);
    const concurrent = await h.app.inject({ method: 'POST', url: `/api/v1/conversations/${c.id}/messages`, payload: { expectedRevision: pending.revision, question: 'another', settings } });
    expect(concurrent.statusCode).toBe(409);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/conversations/${c.id}` })).statusCode).toBe(409);
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/conversations/${c.id}/cancel`, payload: {} })).json()).toEqual({ cancelled: true });
    await cursor.reader.cancel(); cursor.reader.releaseLock();
    await expect.poll(async () => (await get(h, c.id)).turns[0]?.status).toBe('cancelled');
    const cancelled = await get(h, c.id); expect(cancelled.turns[0]?.answer).toBe('尚未完成的回答');
    slow = false; await ask(h, cancelled, 'Alpha 的合作是什么？');
    const body = h.model.requests.filter(isGeneration).at(-1)?.body as { messages: { content: string }[] };
    expect(body.messages).toHaveLength(2); expect(JSON.stringify(body.messages)).not.toContain('尚未完成');
  } finally { await h.close(); }
});

it('marks persisted pending turns interrupted at startup and rejects unsafe or invalid requests', async () => {
  const h = await generationHarness();
  try {
    const c = await create(h);
    const requestCount = h.model.requests.length;
    for (const patch of [{ question: ' ' }, { settings: { ...settings, relatedChunkNumber: -1 } }, { expectedRevision: -1 }]) {
      const bad = await h.app.inject({ method: 'POST', url: `/api/v1/conversations/${c.id}/messages`, payload: { expectedRevision: 0, question: 'Alpha?', settings, ...patch } });
      expect(bad.statusCode).toBe(400);
    }
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/conversations', headers: { origin: 'http://evil.invalid' }, payload: {} })).statusCode).toBe(403);
    expect(h.model.requests.length).toBe(requestCount);
    await h.storage.transact(draft => {
      const current = draft.conversations.get(c.id)!;
      current.turns.push({ id: 'interrupted-turn', question: 'Alpha?', answer: '', status: 'generating', createdAt: c.createdAt, references: [], warnings: [], settings });
      draft.conversations.set(c.id, current);
    });
    await h.app.close(); await h.storage.close();
    const storage = await SnapshotStore.open(h.directory.path), app = await buildApp({ storage });
    try {
      const restored = ConversationSchema.parse((await app.inject(`/api/v1/conversations/${c.id}`)).json());
      expect(restored.turns[0]).toMatchObject({ status: 'interrupted', error: '服务重启中断回答，请重新提问' });
    } finally { await app.close(); await storage.close(); }
  } finally { await h.close(); }
});

it('fits recent completed history into the model budget while retaining full records and excluding truncated answers', async () => {
  const h = await generationHarness();
  try {
    const saved = await h.app.inject({ method: 'PUT', url: '/api/v1/settings/models', payload: { expectedRevision: 1,
      profiles: [textProfile(h.model.url, { maxOutputTokens: 26384, contextTokens: 32768 }), embeddingProfile(h.model.url)], bindings: { ...bindings, rerank: null } } });
    expect(saved.statusCode).toBe(200);
    const c = await create(h);
    await h.storage.transact(draft => {
      const current = draft.conversations.get(c.id)!;
      current.turns = [0, 1, 2].map(n => ({ id: `past-${String(n)}`, question: `past question ${String(n)}`, answer: n === 2 ? 'TRUNCATED_PRIVATE' : 'word '.repeat(4000),
        status: 'completed', finishReason: n === 2 ? 'length' : 'stop', createdAt: c.createdAt, references: [], warnings: [], settings }));
      draft.conversations.set(c.id, current);
    });
    const result = await ask(h, c, 'Alpha?');
    expect(result.turns).toHaveLength(4); expect(result.turns[0]?.answer.length).toBe(20000);
    expect(result.turns[3]?.warnings.join()).toContain('完整记录仍保留');
    const body = h.model.requests.filter(isGeneration).at(-1)?.body as { messages: { content: string }[] };
    expect(JSON.stringify(body)).not.toContain('past question 0'); expect(JSON.stringify(body)).not.toContain('TRUNCATED_PRIVATE');
    expect(JSON.stringify(body)).toContain('past question 1');
  } finally { await h.close(); }
});
