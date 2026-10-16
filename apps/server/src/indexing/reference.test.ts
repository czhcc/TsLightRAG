import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalizeName, parseExtraction, entityId } from './extraction.js';
import { mergeContributions, deduplicateDescriptions } from './merge.js';
import { kg } from '../../../../tests/helpers/indexing.js';
const input = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/graph/s06-input.json', import.meta.url), 'utf8')) as {
  names:string[]; descriptions:{stored:string[];incoming:string[]}; weights:{storedSources:string[];storedWeights:number[];incoming:{source_id:string;weight:number}[];sources:string[]}[];
};
const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/graph/s06-python-reference.json', import.meta.url), 'utf8')) as {names:string[];descriptions:string[];weights:number[]};
it('matches executed pinned Python helpers for selected G01 names and G02 description dedup', () => {
  expect(input.names.map(normalizeName)).toEqual(reference.names);
  expect(deduplicateDescriptions([...input.descriptions.stored,...input.descriptions.incoming])).toEqual(reference.descriptions);
});
it('matches pinned upstream new-source sum, retry exclusion and evidence floor', () => {
  const result = input.weights.map((c) => {
    const first = mergeContributions(c.storedSources.map((chunkId) => ({chunkId,value:parseExtraction(JSON.stringify(kg()))})),[],[]);
    if (first.edges[0]) first.edges[0].weight = c.storedWeights.reduce((a,b) => a+b,0);
    const incoming = c.incoming.map((r) => { const value = parseExtraction(JSON.stringify(kg())); value.relationships[0]!.strength = r.weight; return {chunkId:r.source_id,value}; });
    return mergeContributions(incoming,first.nodes,first.edges).edges[0]?.weight;
  });
  expect(result).toEqual(reference.weights); expect(entityId('Alpha')).not.toBe(entityId('alpha'));
});
