import { z } from 'zod';
import type { PrivateProfile } from './config.js';
import { ModelError, invalid } from './errors.js';
import { ModelTransport, responseChunks, responseJson } from './http.js';

type TextProfile = Extract<PrivateProfile, { kind: 'text' }>;
type EmbeddingProfile = Extract<PrivateProfile, { kind: 'embedding' }>;
type RerankProfile = Extract<PrivateProfile, { kind: 'rerank' }>;
export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
const Usage = z.object({ prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(), total_tokens: z.number().int().nonnegative().optional() });
const Chat = z.object({ choices: z.array(z.object({
  message: z.object({ content: z.string().min(1), tool_calls: z.array(z.unknown()).max(0).nullish(), function_call: z.null().optional(), refusal: z.null().optional() }),
  finish_reason: z.enum(['stop', 'length']),
})).length(1), usage: Usage.nullish() });
const EmptyChat = z.object({ choices: z.array(z.object({
  message: z.object({ content: z.string().nullish() }), finish_reason: z.literal('length'),
})).length(1) });
export type ChatResult = { text: string; finishReason: 'stop' | 'length'; usage?: z.infer<typeof Usage> };
const Frame = z.object({ choices: z.array(z.object({ index: z.literal(0).optional(),
  delta: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).max(0).nullish(), function_call: z.null().optional(), refusal: z.null().optional() }),
  finish_reason: z.enum(['stop', 'length']).nullable().optional(),
})).max(1), usage: Usage.nullable().optional() });

export class ModelClient {
  constructor(private readonly transport = new ModelTransport()) {}
  async chat(profile: TextProfile, messages: Message[], options: { signal?: AbortSignal; onDelta?: (text: string) => void | Promise<void> } = {}): Promise<ChatResult> {
    if (!messages.length || messages.some((m) => !m.content.trim() || !['system', 'user', 'assistant'].includes(m.role))) throw new ModelError('INVALID_MODEL_INPUT', '文本模型输入不能为空', 400);
    let emitted = false;
    return this.transport.run(profile, { ...profile.extraBody, model: profile.model, messages, temperature: profile.temperature,
      max_tokens: profile.maxOutputTokens, stream: Boolean(options.onDelta),
      ...(options.onDelta ? { stream_options: { include_usage: true } } : {}),
    }, options.signal, async (response) => {
      if (!String(response.headers['content-type']).includes('text/event-stream')) {
        const body = await responseJson(response);
        const empty = EmptyChat.safeParse(body);
        if (empty.success && !empty.data.choices[0]?.message.content?.trim()) {
          throw new ModelError('MODEL_OUTPUT_LIMIT', '模型达到最大输出 token 上限但未返回回答正文；请提高最大输出 token，或在模型服务端调整思考模式');
        }
        const parsed = Chat.safeParse(body);
        if (!parsed.success) throw invalid('文本模型响应不符合 OpenAI Chat Completions 格式；需要 choices[0].message.content 为非空文本及 finish_reason 为 stop/length，请检查模型协议和 Base URL');
        const choice = parsed.data.choices[0]; if (!choice?.message.content.trim()) throw invalid('文本模型未返回非空回答正文；思考内容不能替代正文，请检查输出 token 预算和模型设置');
        if (options.onDelta) { emitted = true; await options.onDelta(choice.message.content); }
        return { text: choice.message.content, finishReason: choice.finish_reason, ...(parsed.data.usage ? { usage: parsed.data.usage } : {}) };
      }
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = ''; let text = ''; let finish: 'stop' | 'length' | undefined;
      let done = false; let usage: z.infer<typeof Usage> | undefined;
      const frame = async (raw: string) => {
        const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) return;
        if (done) throw invalid();
        if (data.trim() === '[DONE]') { done = true; return; }
        let json: unknown; try { json = JSON.parse(data) as unknown; } catch { throw invalid(); }
        const parsed = Frame.safeParse(json); if (!parsed.success) throw invalid();
        if (parsed.data.usage) usage = parsed.data.usage;
        const choice = parsed.data.choices[0];
        if (!choice) return;
        if (finish && choice.delta.content) throw invalid();
        if (choice.delta.content) { text += choice.delta.content; emitted = true; await options.onDelta?.(choice.delta.content); }
        if (choice.finish_reason) finish = choice.finish_reason;
      };
      for await (const bytes of responseChunks(response)) {
        try { pending += decoder.decode(bytes, { stream: true }); } catch { throw invalid(); }
        // A CRLF pair may straddle network chunks, so normalize only complete frames.
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          await frame(pending.slice(0, boundary.index).replace(/\r\n/g, '\n'));
          pending = pending.slice(boundary.index + boundary[0].length);
        }
        if (done) break;
      }
      try { pending += decoder.decode(); } catch { throw invalid(); }
      if (!done || !finish || !text.trim()) throw invalid();
      return { text, finishReason: finish, ...(usage ? { usage } : {}) };
    }, () => emitted);
  }
  async embed(profile: EmbeddingProfile, input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!input.length || input.length > 10_000 || input.some((s) => !s.trim())) throw new ModelError('INVALID_MODEL_INPUT', '向量输入不能为空或超过限制', 400);
    const result: number[][] = [];
    for (let start = 0; start < input.length; start += profile.batchSize) {
      const batch = input.slice(start, start + profile.batchSize);
      const rows = await this.transport.run(profile, { model: profile.model, input: batch, encoding_format: 'float' }, signal, async (response) => {
        const parsed = z.object({ data: z.array(z.object({ index: z.number().int().min(0).max(batch.length - 1),
          embedding: z.array(z.number().finite()).length(profile.dimensions) })).length(batch.length) }).safeParse(await responseJson(response));
        if (!parsed.success || new Set(parsed.data.data.map((r) => r.index)).size !== batch.length) throw invalid();
        const sorted = parsed.data.data.sort((a, b) => a.index - b.index).map((r) => r.embedding);
        for (const vector of sorted) {
          let norm = 0; for (const v of vector) norm = Math.hypot(norm, v);
          if (!norm || !Number.isFinite(norm)) throw invalid();
        }
        return sorted;
      });
      result.push(...rows);
    }
    return result;
  }
  async rerank(profile: RerankProfile | undefined, query: string, documents: string[], signal?: AbortSignal, enabled = profile?.enabled ?? false): Promise<{ results: { index: number; score: number }[]; warnings: string[] }> {
    if (!enabled) return { results: documents.map((_, index) => ({ index, score: 0 })), warnings: [] };
    if (!profile) throw new ModelError('MODEL_NOT_CONFIGURED', '重排已启用但未配置模型', 409);
    try {
      if (!query.trim() || !documents.length || documents.length > 1000) throw new ModelError('INVALID_MODEL_INPUT', '重排输入不合法', 400);
      const topN = Math.min(profile.topN, documents.length);
      const results = await this.transport.run(profile, { model: profile.model, query, documents, top_n: topN }, signal, async (response) => {
        const parsed = z.object({ results: z.array(z.object({ index: z.number().int().min(0).max(documents.length - 1), relevance_score: z.number().finite() })).length(topN) }).safeParse(await responseJson(response));
        if (!parsed.success || new Set(parsed.data.results.map((r) => r.index)).size !== topN) throw invalid();
        return parsed.data.results.map((r) => ({ index: r.index, score: r.relevance_score })).sort((a, b) => b.score - a.score);
      });
      return { results, warnings: [] };
    } catch (error) {
      if (signal?.aborted || (error instanceof ModelError && ['MODEL_CANCELLED', 'INVALID_MODEL_INPUT'].includes(error.code)) || profile.failurePolicy === 'fail') throw error;
      return { results: documents.map((_, index) => ({ index, score: 0 })), warnings: ['重排失败，按配置保留原始检索顺序'] };
    }
  }
  async test(profile: PrivateProfile, signal?: AbortSignal) {
    if (profile.kind === 'text') {
      const result = await this.chat(profile, [{ role: 'user', content: 'Reply with a short greeting. This is a connection test.' }], { ...(signal ? { signal } : {}) });
      if (result.finishReason === 'length') return { ok: true as const, kind: profile.kind, message: '模型协议测试通过，但回答达到最大输出 token 上限；请检查输出预算' };
    }
    if (profile.kind === 'embedding') {
      await this.embed(profile, ['TsLightRAG connection test'], signal);
      return { ok: true as const, kind: profile.kind, message: '向量协议测试通过', dimensions: profile.dimensions };
    }
    if (profile.kind === 'rerank') await this.rerank({ ...profile, enabled: true, failurePolicy: 'fail' }, 'graph retrieval', ['graph retrieval evidence', 'unrelated weather'], signal);
    return { ok: true as const, kind: profile.kind, message: '模型协议测试通过' };
  }
}
