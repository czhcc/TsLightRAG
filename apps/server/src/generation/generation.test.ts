import {expect,it} from 'vitest';
import {citationWarnings,textParts} from './service.js';
it('warns on nonexistent numeric/grouped/DC references without inventing or silently replacing citations',()=>{
 expect(citationWarnings('证据 [1] [1, 2]', ['1','2'])).toEqual([]);
 const warnings=citationWarnings('证据 [1, 999] 和 [DC77]。',['1']);expect(warnings.join()).toContain('999');expect(warnings.join()).toContain('DC77');
});
it('splits large transport deltas without separating Unicode surrogate pairs',()=>{
 const input='x'.repeat(15999)+'🧮'+'y'.repeat(20000);const parts=textParts(input);expect(parts.join('')).toBe(input);expect(parts.every(p=>p.length<=16000)).toBe(true);expect(parts[0]).toHaveLength(15999);
});
