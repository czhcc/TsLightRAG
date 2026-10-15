import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import o200k from 'js-tiktoken/ranks/o200k_base';
export type Encoding = 'cl100k_base' | 'o200k_base';
export const TOKENIZER_VERSION = 'js-tiktoken@1.0.21';
const cache = new Map<Encoding, Tiktoken>();
export function tokenizer(encoding: Encoding = 'cl100k_base') {
  if (!['cl100k_base', 'o200k_base'].includes(encoding)) throw new Error('Unsupported tokenizer encoding');
  let encoder = cache.get(encoding);
  if (!encoder) { encoder = new Tiktoken(encoding === 'cl100k_base' ? cl100k : o200k); cache.set(encoding, encoder); }
  return { encode: (text: string) => encoder.encode(text, [], []), decode: (tokens: number[]) => encoder.decode(tokens) };
}
export function countTokens(text: string, encoding: Encoding = 'cl100k_base') { return tokenizer(encoding).encode(text).length; }
