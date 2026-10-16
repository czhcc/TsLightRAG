import { parseFragment } from 'parse5';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ModelClient, Message } from '../models/client.js';
import type { PrivateProfile } from '../models/config.js';
import { ModelError } from '../models/errors.js';
import { countTokens } from '../core/tokenizer.js';
import { prompts, render, PROMPT_VERSION } from './prompts.js';

export const EXTRACTION_VERSION = `${PROMPT_VERSION}-nfkc-v1-glean1-repair1`;
const field = z.string().trim().min(1).max(20_000);
const name = z.string().trim().min(1).max(512);
const RecordsSchema = z.strictObject({
  entities: z.array(z.strictObject({ name, type: name, description: field })).max(200),
  relationships: z.array(z.strictObject({ source: name, target: name, keywords: field, description: field,
    // Optional extension: standard upstream JSON defaults to strength 1.
    strength: z.number().finite().min(0).max(1000).default(1) })).max(200),
});
export const ExtractionSchema = RecordsSchema.refine((v) => v.entities.length + v.relationships.length <= 100, 'Response record limit');
export const ContributionSchema = RecordsSchema.refine((v) => v.entities.length + v.relationships.length <= 200, 'Combined record limit');
export const LedgerSchema = z.strictObject({ version: z.literal(EXTRACTION_VERSION), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  configRevision: z.number().int().nonnegative(), contribution: ContributionSchema });
export type Extraction = z.infer<typeof ExtractionSchema>;
export const sanitizeDescription = (s: string) => Array.from(s.replace(/&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);?/g, (entity) => {
  const node = parseFragment(entity).childNodes[0];
  return node && 'value' in node ? node.value : entity;
})).filter((c) => {
  const n = c.codePointAt(0)!;
  return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xD7FF && n !== 127) || (n >= 0xE000 && n <= 0xFFFD) || n >= 0x10000;
}).join('').trim();
export const normalizeName = (s: string) => s.normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const entityId = (name: string) => `ent-${hash(normalizeName(name))}`;
export function parseExtraction(raw: string): Extraction {
  // Accept a single complete JSON fence; never salvage a substring or silently drop rows.
  const text = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1');
  let value: unknown; try { value = JSON.parse(text) as unknown; } catch { throw new ModelError('EXTRACTION_INVALID', '抽取结果不是完整 JSON'); }
  const parsed = ExtractionSchema.safeParse(value);
  if (!parsed.success) throw new ModelError('EXTRACTION_INVALID', '抽取结果不符合实体与关系 JSON 契约');
  const result = parsed.data;
  for (const e of result.entities) { e.name = normalizeName(e.name); e.type = normalizeName(e.type).split(',').map((v) => v.trim()).find(Boolean)?.replaceAll(' ', '').toLowerCase() ?? '';
    if (/['()<>|/\\]/u.test(e.type) || ['constructor', '__proto__', 'prototype'].includes(e.type)) throw new ModelError('EXTRACTION_INVALID', '实体类型包含非法结构或保留名称');
    e.description = sanitizeDescription(e.description); }
  for (const r of result.relationships) {
    r.description = sanitizeDescription(r.description); r.source = normalizeName(r.source); r.target = normalizeName(r.target);
    const keywords = [...new Set(r.keywords.split(',').map((v) => normalizeName(v)).filter(Boolean))].sort();
    if (keywords.length > 100 || !keywords.length) throw new ModelError('EXTRACTION_INVALID', '关系关键词为空或超过上限');
    r.keywords = keywords.join(', ');
  }
  if (result.entities.some((e) => !e.name || !e.type || !e.description) || result.relationships.some((r) => !r.source || !r.target || r.source === r.target || !r.description)) throw new ModelError('EXTRACTION_INVALID', '规范化后的名称/描述为空或关系连接自身');
  return result;
}
export function combineExtractions(rounds: Extraction[]): Extraction {
  const entities = new Map<string, Extraction['entities'][number]>();
  const relationships = new Map<string, Extraction['relationships'][number]>();
  for (const round of rounds) {
    for (const e of round.entities) entities.set(e.name, e); // Gleaned corrections replace the same source contribution.
    for (const r of round.relationships) {
      const [source, target] = [r.source, r.target].sort();
      relationships.set(JSON.stringify([source, target]), { ...r, source: source!, target: target! });
    }
  }
  for (const r of relationships.values()) if (!entities.has(r.source) || !entities.has(r.target)) throw new ModelError('EXTRACTION_ENDPOINT', '关系端点缺少实体贡献');
  return { entities: [...entities.values()], relationships: [...relationships.values()] };
}
export async function extract(client: ModelClient, profile: Extract<PrivateProfile, {kind: 'text'}>, text: string, signal: AbortSignal) {
  const values = { language: 'Chinese', max_total_records: 100, max_entity_records: 100,
    entity_types_guidance: 'Person, Organization, Location, Event, Concept, Method, Content, Data, Artifact, NaturalObject, Other',
    examples: prompts.entity_extraction_json_examples[0], heading_context_block: '', input_text: text };
  const messages: Message[] = [{ role: 'system', content: render(prompts.entity_extraction_json_system_prompt, values) },
    { role: 'user', content: render(prompts.entity_extraction_json_user_prompt, values) }];
  async function request() {
    for (let repair = 0; repair <= 1; repair++) {
      if (countTokens(messages.map((m) => m.content).join('\n'), profile.tokenizer) + profile.maxOutputTokens + 256 > profile.contextTokens) throw new ModelError('EXTRACTION_CONTEXT', '抽取上下文超过所配置文本模型预算');
      const answer = await client.chat(profile, messages, { signal });
      if (answer.finishReason !== 'stop') throw new ModelError('EXTRACTION_TRUNCATED', '模型抽取输出被截断，请增大输出预算后重试');
      messages.push({ role: 'assistant', content: answer.text });
      try { return parseExtraction(answer.text); } catch (error) {
        if (repair === 1) throw error;
        messages.push({ role: 'user', content: 'The previous output violates the JSON contract. Return the complete corrected JSON object only, with entities and relationships arrays; no invented facts or extra fields.' });
      }
    }
    throw new ModelError('EXTRACTION_INVALID', '抽取修复失败');
  }
  const first = await request(); combineExtractions([first]);
  messages.push({ role: 'user', content: render(prompts.entity_continue_extraction_json_user_prompt, values) });
  const second = await request();
  return combineExtractions([first, second]);
}
