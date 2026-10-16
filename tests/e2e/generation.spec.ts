import {test,expect} from '@playwright/test';
import {startService} from '../helpers/owned-service.js';
import {startFakeModel} from '../helpers/fake-model.js';
import {generationHandler,isGeneration,sseDelta,sseDone} from '../helpers/generation.js';
import {textProfile,embeddingProfile,bindings} from '../helpers/model-profiles.js';
test('browser streams actual answers/citations, reads a completed cache and stops the upstream without caching partial text',async({page})=>{
 let hold=false,closed=false;
 const model=await startFakeModel((request,response)=>{
  if(isGeneration(request)){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write(sseDelta(hold?'部分回答 [1]':'Alpha 与 Beta 协作 [1]。'));if(hold)response.on('close',()=>{closed=true;});else setTimeout(()=>response.end(sseDone),20);}
  else generationHandler(request,response);
 });const service=await startService();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  expect((await page.request.put(`${service.address}/api/v1/settings/models`,{data:{expectedRevision:0,profiles:[textProfile(model.url),embeddingProfile(model.url)],bindings:{...bindings,rerank:null}}})).status()).toBe(200);
  const imported=await page.request.post(`${service.address}/api/v1/documents/text`,{data:{name:'证据.txt',text:'first document Alpha Beta cooperation'}});const job=(await imported.json() as {job:{id:string}}).job.id;
  await expect.poll(async()=>((await(await page.request.get(`${service.address}/api/v1/jobs/${job}`)).json()) as {status:string}).status,{timeout:15000}).toBe('processed');
  await page.goto(`${service.address}/query`);await page.getByRole('textbox',{name:'检索问题',exact:true}).fill('Alpha cooperation?');await page.getByRole('button',{name:'生成回答',exact:true}).click();
  const answer=page.getByRole('region',{name:'知识库回答',exact:true});await expect(answer.getByRole('status')).toHaveText('回答完成');await expect(answer.locator('pre')).toHaveText('Alpha 与 Beta 协作 [1]。');await expect(answer.getByRole('listitem')).toHaveText('[1] 证据.txt');
  await page.getByRole('button',{name:'生成回答',exact:true}).click();await expect(answer.getByRole('status')).toHaveText('回答完成（缓存）');expect(model.requests.filter(isGeneration)).toHaveLength(1);
  hold=true;await page.getByRole('textbox',{name:'检索问题',exact:true}).fill('cancel question');await page.getByRole('button',{name:'生成回答',exact:true}).click();await expect(answer.locator('pre')).toHaveText('部分回答 [1]');await page.getByRole('button',{name:'停止生成',exact:true}).click();await expect(answer.getByRole('status')).toContainText('回答已取消');await expect.poll(()=>closed).toBe(true);
  hold=false;await page.getByRole('button',{name:'生成回答',exact:true}).click();await expect(answer.getByRole('status')).toHaveText('回答完成');expect(model.requests.filter(isGeneration)).toHaveLength(3);expect(errors).toEqual([]);
  await page.screenshot({path:test.info().outputPath('s09-answer.png'),fullPage:true});
 }finally{await service.stop();await model.stop();}
});
