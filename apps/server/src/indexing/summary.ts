import type { ModelClient } from '../models/client.js';
import type { PrivateProfile } from '../models/config.js';
import { ModelError } from '../models/errors.js';
import { countTokens } from '../core/tokenizer.js';
import { sanitizeDescription } from './extraction.js';
import { prompts, render } from './prompts.js';
// Adapted bounded map/reduce from operate.py::_handle_entity_relation_summary;
// upstream SHA and MIT attribution: prompts.ts / third_party/LightRAG/LICENSE.
export async function summarizeDescriptions(client: ModelClient, profile: Extract<PrivateProfile, {kind: 'text'}>, name: string, list: string[], signal: AbortSignal): Promise<string> {
  if (list.length === 1) return list[0]!;
  const tokens = list.reduce((n, d) => n + countTokens(d, profile.tokenizer), 0);
  if (list.length < 8 && tokens < 500) return list.join('<SEP>');
  // Bounded map/reduce, shrinking both input count and token volume. Never silently truncate facts.
  const context = Math.min(8192, profile.contextTokens - profile.maxOutputTokens - 1024);
  if (context <= 0) throw new ModelError('SUMMARY_CONTEXT', '描述摘要上下文预算不足');
  if (tokens > context && list.length > 2) {
    const groups: string[][] = []; let group: string[] = []; let size = 0;
    for (const item of list) {
      const n = countTokens(item, profile.tokenizer);
      if (group.length >= 2 && size + n > context) { groups.push(group); group = []; size = 0; }
      group.push(item); size += n;
    }
    if (group.length) groups.push(group);
    if (groups.length >= list.length) throw new ModelError('SUMMARY_CONTEXT', '描述无法在摘要预算内分组');
    const reduced: string[] = [];
    for (const g of groups) reduced.push(await summarizeDescriptions(client, profile, name, g, signal));
    if (countTokens(reduced.join('\n'), profile.tokenizer) >= tokens) throw new ModelError('SUMMARY_NO_PROGRESS', '描述摘要未缩减输入，请检查模型');
    return summarizeDescriptions(client, profile, name, reduced, signal);
  }
  const prompt = render(prompts.summarize_entity_descriptions, { description_type: 'Entity or relation', description_name: name,
    description_list: list.map((description) => JSON.stringify({ description })).join('\n'), summary_length: 500, language: 'Chinese' });
  if (countTokens(prompt, profile.tokenizer) + profile.maxOutputTokens + 256 > profile.contextTokens) throw new ModelError('SUMMARY_CONTEXT', '描述摘要超过模型上下文');
  const result = await client.chat(profile, [{ role: 'user', content: prompt }], { signal });
  if (result.finishReason !== 'stop' || countTokens(result.text, profile.tokenizer) > 500 || result.text.length > 20_000) throw new ModelError('SUMMARY_INVALID', '描述摘要被截断或超过预算');
  const summary = sanitizeDescription(result.text);
  if (!summary) throw new ModelError('SUMMARY_INVALID', '描述摘要为空');
  return summary;
}
