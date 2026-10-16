import { expect, it } from 'vitest';
import { summarizeDescriptions } from './summary.js';
import { ModelClient } from '../models/client.js';
import { startFakeModel } from '../../../../tests/helpers/fake-model.js';
import { textProfile } from '../../../../tests/helpers/model-profiles.js';
import { reply } from '../../../../tests/helpers/indexing.js';
it('single description bypasses summary; seven short fragments join; eight trigger a bounded summary', async () => {
  const model = await startFakeModel((_r,res) => {reply(res,'Alpha summary.');});
  try {
    const summarize = (list:string[]) => summarizeDescriptions(new ModelClient(),textProfile(model.url),'Alpha',list,new AbortController().signal);
    expect(await summarize(['x '.repeat(600)])).toBe('x '.repeat(600));
    const seven = Array.from({length:7},(_,i)=>`Alpha fact ${String(i)}`);
    expect(await summarize(seven)).toBe(seven.join('<SEP>')); expect(model.requests).toHaveLength(0);
    expect(await summarize([...seven,'Alpha fact 7'])).toBe('Alpha summary.'); expect(model.requests).toHaveLength(1);
  } finally {await model.stop();}
});
it('triggers token threshold and rejects truncated or oversized summary without hiding facts', async () => {
  let truncated = true; const model = await startFakeModel((_r,res) => {reply(res,truncated?'Alpha summary.':'x '.repeat(600),truncated?'length':'stop');});
  try {
    const summarize = () => summarizeDescriptions(new ModelClient(),textProfile(model.url),'Alpha',['x '.repeat(300),'y '.repeat(300)],new AbortController().signal);
    await expect(summarize()).rejects.toHaveProperty('code','SUMMARY_INVALID'); truncated=false;
    await expect(summarize()).rejects.toHaveProperty('code','SUMMARY_INVALID');
  } finally {await model.stop();}
});
it('map/reduce groups large lists and terminates when summaries do not shrink', async () => {
  const model = await startFakeModel((_r,res) => {reply(res,'Alpha summary.');});
  try {
    const result = await summarizeDescriptions(new ModelClient(),textProfile(model.url),'Alpha',Array.from({length:4},(_,i)=>`${String(i)} ${'fact '.repeat(2300)}`),new AbortController().signal);
    expect(result).toContain('Alpha summary.'); expect(model.requests).toHaveLength(2);
    await expect(summarizeDescriptions(new ModelClient(),textProfile(model.url,{contextTokens:3073}),'Alpha',Array(8).fill('A') as string[],new AbortController().signal)).rejects.toHaveProperty('code','SUMMARY_NO_PROGRESS');
  } finally {await model.stop();}
});
