import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {mergeContributions} from './merge.js';
import {parseExtraction} from './extraction.js';
import {kg} from '../../../../tests/helpers/indexing.js';
const reference=JSON.parse(readFileSync(new URL('../../../../tests/fixtures/graph/s07-python-reference.json',import.meta.url),'utf8')) as {cases:{weights:number[];sources:string[];expectedWeight:number}[]};
it('re-derives surviving source strengths with the exact pinned Python rebuild weight floor, discarding old boosts',()=>{
  for(const c of reference.cases){const contributions=c.weights.map((strength,i)=>{const value=parseExtraction(JSON.stringify(kg()));value.relationships[0]!.strength=strength;return{chunkId:c.sources[i]!,value};});expect(mergeContributions(contributions,[],[]).edges[0]?.weight).toBe(c.expectedWeight);}
});
