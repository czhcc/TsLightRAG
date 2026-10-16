import {expect,it} from 'vitest';
import {roundRobin} from './algorithms.js';
it('uses separate graph and final chunk interleaving with vector first and stable deduplication',()=>{
 expect(roundRobin([['e1','e2','e3'],['e2','e4']],s=>s)).toEqual(['e1','e2','e4','e3']);
 expect(roundRobin([['v1','shared'],['shared','e2'],['r1','e2','r3']],s=>s)).toEqual(['v1','shared','r1','e2','r3']);
});
