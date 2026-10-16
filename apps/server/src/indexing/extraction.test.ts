import { expect, it } from 'vitest';
import { parseExtraction, combineExtractions, normalizeName, entityId, extract } from './extraction.js';
import { ModelClient } from '../models/client.js';
import { startFakeModel } from '../../../../tests/helpers/fake-model.js';
import { textProfile } from '../../../../tests/helpers/model-profiles.js';
import { kg, empty, reply } from '../../../../tests/helpers/indexing.js';
it('accepts strict JSON and one complete fence; preserves Unicode/case distinction', () => {
  expect(parseExtraction(`\x60\x60\x60json\n${JSON.stringify(kg())}\n\x60\x60\x60`)).toEqual(parseExtraction(JSON.stringify(kg())));
  expect(normalizeName(' Ａlpha  中文 ')).toBe('Alpha 中文'); expect(entityId('Alpha')).not.toBe(entityId('alpha'));
});
it.each(['text '+JSON.stringify(empty), '[]', '{"entities":{},"relationships":[]}', '{"entities":[],"relationships":[],"extra":true}', JSON.stringify({ ...kg(), entities: Array(101).fill(kg().entities[0]) }), JSON.stringify({ ...kg(), relationships: [{ ...kg().relationships[0], strength: -1 }] }), JSON.stringify({ ...kg(), relationships: [{ ...kg().relationships[0], keywords: ' , ' }] })])('rejects malformed, unknown or over-limit records %s', (text) => { expect(() => parseExtraction(text)).toThrow(); });
it('defaults upstream JSON weight to one; deduplicates undirected corrected gleaning and rejects missing endpoints', () => {
  const input = kg(); const r: Record<string, unknown> = { ...input.relationships[0]! }; delete r.strength;
  expect(parseExtraction(JSON.stringify({ ...input, relationships: [r] })).relationships[0]?.strength).toBe(1);
  const corrected = kg(); corrected.relationships[0]!.description = 'Corrected';
  const combined = combineExtractions([parseExtraction(JSON.stringify(input)), parseExtraction(JSON.stringify(corrected))]);
  expect(combined.relationships).toHaveLength(1); expect(combined.relationships[0]?.description).toBe('Corrected');
  expect(() => combineExtractions([{ entities: [], relationships: combined.relationships }])).toThrow('端点');
});
it('bounded repair then exactly one gleaning round; uses upstream language and input-only instructions', async () => {
  let calls = 0; const model = await startFakeModel((_request, response) => { calls++; reply(response, calls === 1 ? '{bad' : calls === 2 ? kg() : empty); });
  try {
    expect((await extract(new ModelClient(), textProfile(model.url), 'Alpha and Beta collaborate.', new AbortController().signal)).relationships).toHaveLength(1);
    expect(calls).toBe(3);
    const body = model.requests[0]?.body as { messages: {content: string}[] };
    expect(body.messages[0]?.content).toContain('Chinese'); expect(body.messages[0]?.content).toContain('not source text');
  } finally { await model.stop(); }
});
it.each(['invalid', 'length'])('fails explicitly on %s output without unbounded repair', async (mode) => {
  const model = await startFakeModel((_request, response) => { reply(response, mode === 'invalid' ? 'not JSON' : kg(), mode === 'length' ? 'length' : 'stop'); });
  try { await expect(extract(new ModelClient(), textProfile(model.url), 'evidence', new AbortController().signal)).rejects.toHaveProperty('code', mode === 'length' ? 'EXTRACTION_TRUNCATED' : 'EXTRACTION_INVALID'); expect(model.requests).toHaveLength(mode === 'length' ? 1 : 2); }
  finally { await model.stop(); }
});
it('allows up to 200 combined records while enforcing 100 per response', async () => {
  const { LedgerSchema, EXTRACTION_VERSION, hash } = await import('./extraction.js');
  const entities = Array.from({length:100},(_,i)=>({name:`Entity ${String(i)}`,type:'Concept',description:'A named concept.'}));
  const first = parseExtraction(JSON.stringify({entities,relationships:[]}));
  const second = parseExtraction(JSON.stringify({entities:entities.map((e)=>({...e,name:`Extra ${e.name}`})),relationships:[]}));
  const contribution = combineExtractions([first,second]); expect(contribution.entities).toHaveLength(200);
  expect(LedgerSchema.parse({version:EXTRACTION_VERSION,configRevision:1,contentHash:hash('input'),contribution}).contribution.entities).toHaveLength(200);
  expect(()=>parseExtraction(JSON.stringify(contribution))).toThrow();
});
