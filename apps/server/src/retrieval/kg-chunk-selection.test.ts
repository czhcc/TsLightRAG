import {expect,it} from 'vitest';
import {reference} from '../../../../tests/helpers/retrieval.js';
import {sourceGroups,selectSources,weightedPolling,vectorQuota,pythonRound} from './algorithms.js';
for(const c of reference.selection)it(`Python source selection ${c.method} missing-vector=${String(c.missing)}`,()=>{
 const warnings:string[]=[];
 expect(selectSources(['A','B','C'].map(n=>reference.nodes[n]!.source_id.split('<SEP>')),{method:c.method,related:2,queryVector:[1,0],vector:id=>c.missing&&id==='z'?undefined:reference.vectors[id],warnings})).toEqual(c.expected);
 expect(warnings.length).toBe(c.missing&&c.method==='VECTOR'?1:0);
});
for(const c of reference.polling)it(`Python weighted polling redistribution ${String(c.related)}`,()=>{expect(weightedPolling(c.groups,c.related)).toEqual(c.expected);});
it('drops excluded entity evidence before frequencies/groups and owns duplicates at first position',()=>{
 const {groups,count}=sourceGroups([['shared','a'],['shared','b','a'],['shared']],['shared']);
 expect(groups).toEqual([['a'],['b']]);expect(count.get('shared')).toBeUndefined();expect(count.get('a')).toBe(2);
});
it('VECTOR ties follow source appearance, restrict candidates, and obey zero kill switch',()=>{
 const options={method:'VECTOR' as const,related:1,queryVector:[1,0],vector:()=>[1,0],warnings:[]};
 expect(selectSources([['z','a'],['b']],options)).toEqual(['z']);
 expect(selectSources([['z']],{...options,related:0})).toEqual([]);
 expect(selectSources([['z']],{method:'VECTOR',related:5,vector:()=>[1,0],warnings:[]})).toEqual([]);
 expect(vectorQuota(1,1)).toBe(1);expect(vectorQuota(5,3)).toBe(7);expect(vectorQuota(0,9)).toBe(0);
 expect([0.5,1.5,2.5,3.5].map(pythonRound)).toEqual([0,2,2,4]);
});
