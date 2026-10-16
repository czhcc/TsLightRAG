import {expect,it} from 'vitest';
import {normalizeKeywords} from './service.js';
import {reference} from '../../../../tests/helpers/retrieval.js';
for(const c of reference.normalized)it(`normalizes keyword payload like upstream ${JSON.stringify(c.input)}`,()=>{expect(normalizeKeywords(c.input)).toEqual(c.expected);});
