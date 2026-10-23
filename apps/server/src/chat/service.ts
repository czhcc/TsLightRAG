import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ChatMessageRequestSchema, ChatSettingsSchema, ConversationSchema, QuerySchema } from '@tslightrag/contracts';
import type { Conversation, StreamEvent } from '@tslightrag/contracts';
import type { SnapshotStore } from '../storage/snapshot.js';
import type { GenerationService } from '../generation/service.js';
import type { ModelConfigStore } from '../models/config.js';
import { boundProfile } from '../models/config.js';
import { ModelError } from '../models/errors.js';
import { buildContext } from '../retrieval/context.js';
import { NdjsonWriter } from '../generation/ndjson.js';

const now = () => new Date().toISOString();
const fail = (code: string, message: string, status = 409) => new ModelError(code, message, status);

export class ConversationService {
  private active = new Map<string, AbortController>();
  private running = new Set<Promise<void>>();
  constructor(private storage: SnapshotStore, private generation: GenerationService,
    private config: ModelConfigStore, private shutdown: AbortSignal) {}

  async recover() {
    if (!this.storage.capture().conversations().some(c => c.turns.some(t => t.status === 'generating'))) return;
    await this.storage.transact(draft => {
      for (const [id, c] of draft.conversations.entries()) {
        if (!c.turns.some(t => t.status === 'generating')) continue;
        for (const turn of c.turns) if (turn.status === 'generating') {
          turn.status = 'interrupted'; turn.error = '服务重启中断回答，请重新提问';
        }
        c.revision++; c.updatedAt = now(); draft.conversations.set(id, c);
      }
    });
  }
  list() {
    return this.storage.capture().conversations().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => ({
      id: c.id, title: c.title, revision: c.revision, createdAt: c.createdAt, updatedAt: c.updatedAt,
      status: c.turns.at(-1)?.status ?? null,
    }));
  }
  get(id: string) {
    const conversation = this.storage.capture().conversation(id);
    if (!conversation) throw fail('CONVERSATION_NOT_FOUND', '对话不存在', 404);
    return conversation;
  }
  async create() {
    if (this.shutdown.aborted) throw fail('SERVICE_STOPPING', '服务正在关闭', 503);
    const date = now();
    const c = ConversationSchema.parse({ id: randomUUID(), title: '新对话', revision: 0,
      createdAt: date, updatedAt: date, settings: ChatSettingsSchema.parse({}), turns: [] });
    await this.storage.transact(draft => {
      if (draft.conversations.size >= 200) throw fail('CONVERSATION_LIMIT', '最多保留 200 段对话，请删除不需要的对话');
      draft.conversations.set(c.id, c);
    });
    return c;
  }
  async remove(id: string) {
    await this.storage.transact(draft => {
      const c = draft.conversations.get(id);
      if (!c) throw fail('CONVERSATION_NOT_FOUND', '对话不存在', 404);
      if (c.turns.at(-1)?.status === 'generating') throw fail('CONVERSATION_BUSY', '请先停止生成，再删除对话');
      draft.conversations.delete(id);
    });
  }
  async begin(id: string, input: unknown) {
    const parsed = ChatMessageRequestSchema.safeParse(input);
    if (!parsed.success) throw fail('INVALID_CHAT_MESSAGE', '问题或检索选项不合法', 400);
    if (this.shutdown.aborted) throw fail('SERVICE_STOPPING', '服务正在关闭', 503);
    let result!: Conversation;
    await this.storage.transact(draft => {
      const c = draft.conversations.get(id);
      if (!c) throw fail('CONVERSATION_NOT_FOUND', '对话不存在', 404);
      if (c.revision !== parsed.data.expectedRevision) throw fail('CONVERSATION_CONFLICT', '对话已更新，请重新加载后再发送');
      if (c.turns.at(-1)?.status === 'generating' || this.active.has(id)) throw fail('CONVERSATION_BUSY', '此对话正在生成回答');
      if (c.turns.length >= 100) throw fail('CONVERSATION_TURN_LIMIT', '此对话已达 100 轮，请新建对话');
      if (Buffer.byteLength(JSON.stringify(draft.conversations.entries())) > 64 * 1024 * 1024) {
        throw fail('CONVERSATION_STORAGE_LIMIT', '对话记录超过 64 MiB，请删除不需要的对话');
      }
      c.settings = parsed.data.settings; c.updatedAt = now(); c.revision++;
      if (!c.turns.length) c.title = Array.from(parsed.data.question).slice(0, 40).join('');
      c.turns.push({ id: randomUUID(), question: parsed.data.question, answer: '', createdAt: now(),
        status: 'generating', settings: c.settings, references: [], warnings: [] });
      draft.conversations.set(id, c); result = c;
    });
    return result;
  }
  cancel(id: string) { this.get(id); const controller = this.active.get(id); controller?.abort(); return { cancelled: Boolean(controller) }; }

  run(c: Conversation, requestId: string, signal: AbortSignal, send: (event: StreamEvent) => Promise<void>) {
    const controller = new AbortController(); this.active.set(c.id, controller);
    const combined = AbortSignal.any([signal, controller.signal, this.shutdown]);
    const task = this.generate(c, requestId, combined, send).finally(() => {
      if (this.active.get(c.id) === controller) this.active.delete(c.id);
      this.running.delete(task);
    });
    this.running.add(task); return task;
  }
  private async generate(c: Conversation, requestId: string, signal: AbortSignal, send: (event: StreamEvent) => Promise<void>) {
    const turn = c.turns.at(-1)!;
    let settled = false;
    const persist = async () => {
      await this.storage.transact(draft => {
        const current = draft.conversations.get(c.id);
        if (!current || current.turns.at(-1)?.id !== turn.id) throw fail('CONVERSATION_CONFLICT', '对话已更新');
        current.turns[current.turns.length - 1] = turn;
        current.updatedAt = now(); current.revision++; draft.conversations.set(c.id, current);
      });
      settled = true;
    };
    try {
      const prior = c.turns.slice(0, -1).filter(t => t.status === 'completed' && t.finishReason !== 'length' && t.answer.trim());
      const history = prior.slice(-50).flatMap(t => [
        { role: 'user' as const, content: t.question }, { role: 'assistant' as const, content: t.answer.slice(0, 20000) },
      ]);
      let shortened = prior.length > 50 || prior.some(t => t.answer.length > 20000);
      const query = QuerySchema.parse({ query: turn.question, ...turn.settings, conversationHistory: history });
      const text = boundProfile(this.config.capture(), 'query');
      if (text?.kind === 'text') {
        while (query.conversationHistory.length) {
          try { buildContext(this.storage.capture(), query, text, [], [], []); break; }
          catch (error) {
            if (!(error instanceof ModelError) || error.code !== 'QUERY_BUDGET_EXCEEDED') throw error;
            query.conversationHistory.splice(0, 2); shortened = true;
          }
        }
      }
      if (shortened) turn.warnings.push('本轮上下文已缩短较早或过长的历史消息；完整记录仍保留在对话中');
      await this.generation.answer(query, { requestId, signal, emit: async event => {
        if (event.type === 'references') turn.references = event.references;
        if (event.type === 'delta') {
          if (turn.answer.length + event.text.length > 1024 * 1024) throw fail('CHAT_ANSWER_LIMIT', '回答超过对话单条记录上限', 502);
          turn.answer += event.text;
        }
        if (event.type === 'done') {
          turn.status = 'completed'; turn.finishReason = event.finishReason;
          turn.warnings = [...turn.warnings, ...event.warnings].slice(0, 100);
          await persist(); event = { ...event, warnings: turn.warnings };
        } else if (event.type === 'error') {
          turn.status = 'failed'; turn.error = `${event.error.code}：${event.error.message}`; await persist();
        } else if (event.type === 'cancelled') {
          turn.status = this.shutdown.aborted ? 'interrupted' : 'cancelled'; await persist();
        }
        await send(event);
      } });
    } catch (error) {
      if (!settled) {
        turn.status = this.shutdown.aborted ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed';
        turn.error = error instanceof ModelError ? `${error.code}：${error.message}` : '回答生成或记录保存失败';
      }
    } finally {
      if (!settled) {
        if (turn.status === 'generating') turn.status = this.shutdown.aborted ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed';
        await persist();
        if (!signal.aborted) await send({ type: 'error', error: { code: 'CHAT_INCOMPLETE', message: turn.error ?? '回答未完成', requestId } }).catch(() => {});
      }
    }
  }
  async close() { for (const controller of this.active.values()) controller.abort(); await Promise.allSettled([...this.running]); }
}

export async function registerConversations(app: FastifyInstance, service: ConversationService) {
  await service.recover();
  app.get('/api/v1/conversations', async () => service.list());
  app.post('/api/v1/conversations', async (_request, reply) => reply.code(201).send(await service.create()));
  app.get<{ Params: { id: string } }>('/api/v1/conversations/:id', async request => service.get(request.params.id));
  app.delete<{ Params: { id: string } }>('/api/v1/conversations/:id', async (request, reply) => { await service.remove(request.params.id); return reply.code(204).send(); });
  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/cancel', async request => service.cancel(request.params.id));
  app.post<{ Params: { id: string } }>('/api/v1/conversations/:id/messages', async (request, reply) => {
    const controller = new AbortController();
    const close = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on('close', close);
    try {
      const conversation = await service.begin(request.params.id, request.body);
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" });
      const writer = new NdjsonWriter(reply.raw, controller.signal);
      await service.run(conversation, request.id, controller.signal, event => writer.send(event));
    } finally {
      reply.raw.off('close', close);
      if (reply.sent && !reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    }
  });
}
