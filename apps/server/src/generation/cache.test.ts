import {expect,it} from 'vitest';
import {z} from 'zod';
import {BoundedCache} from './cache.js';
it('bounds LRU entries/bytes/TTL, validates schema and detaches cached values',()=>{
 let clock=0;const cache=new BoundedCache(z.object({value:z.string()}),{entries:2,bytes:100,ttlMs:10},()=>clock);
 expect(cache.set('a',{value:'alpha'})).toBe(true);cache.set('b',{value:'beta'});const a=cache.get('a')!;a.value='mutated';expect(cache.get('a')!.value).toBe('alpha');
 cache.set('c',{value:'gamma'});expect(cache.get('b')).toBeUndefined();expect(cache.size).toBe(2);expect(cache.set('wrong',{value:42})).toBe(false);expect(cache.set('large',{value:'x'.repeat(100)})).toBe(false);
 clock=11;expect(cache.get('a')).toBeUndefined();cache.set('d',{value:'delta'});expect(cache.size).toBe(1);cache.clear();expect(cache.size).toBe(0);
});
