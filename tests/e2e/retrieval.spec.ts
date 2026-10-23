import {test,expect} from '@playwright/test';
import {startService} from '../helpers/owned-service.js';
import {startFakeModel} from '../helpers/fake-model.js';
import {queryHandler} from '../helpers/retrieval.js';
import {textProfile,embeddingProfile,bindings} from '../helpers/model-profiles.js';
test('browser retrieves actual indexed evidence in five modes, previews prompt/locations and survives missing configuration',async({page})=>{
 const model=await startFakeModel(queryHandler);const service=await startService();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(`${service.address}/query`);await page.getByLabel('检索问题',{exact:true}).fill('Alpha cooperation?');await page.getByRole('button',{name:'检索证据',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('请配置文本和向量模型');
  const saved=await page.request.put(`${service.address}/api/v1/settings/models`,{data:{expectedRevision:0,profiles:[textProfile(model.url,{maxOutputTokens:26384,contextTokens:32768}),embeddingProfile(model.url)],bindings:{...bindings,rerank:null}}});expect(saved.status()).toBe(200);
  const imported=await page.request.post(`${service.address}/api/v1/documents/text`,{data:{name:'证据.txt',text:'first document Alpha Beta cooperation'}});const job=(await imported.json() as {job:{id:string}}).job.id;
  await expect.poll(async()=>((await(await page.request.get(`${service.address}/api/v1/jobs/${job}`)).json()) as {status:string}).status,{timeout:15000}).toBe('processed');
  for(const mode of ['naive','local','global','hybrid','mix']){
   await page.getByRole('combobox',{name:'检索模式',exact:true}).selectOption(mode);await page.getByRole('button',{name:'检索证据',exact:true}).click();
   await expect(page.getByRole('status')).toContainText('找到 1 个文本块');await expect(page.getByRole('heading',{name:'[1] 证据.txt',exact:true})).toBeVisible();
  }
  await page.getByText('上下文与预算',{exact:true}).click();await expect(page.locator('pre').filter({hasText:'"branches"'})).toContainText('"entities"');
  await expect(page.locator('pre').filter({hasText:'"branches"'})).toContainText('"limit": 32768');
  await expect(page.locator('pre').filter({hasText:'"branches"'})).toContainText('"reservedOutputTokens": 26384');
  await page.getByText('完整提示词预览',{exact:true}).click();await expect(page.locator('pre').filter({hasText:'---system---'})).toContainText('Alpha cooperation?');
  await page.getByText('原始位置',{exact:true}).click();await expect(page.locator('pre').filter({hasText:'blockIndex'})).toBeVisible();expect(errors).toEqual([]);
  await page.screenshot({path:test.info().outputPath('s08-retrieval.png'),fullPage:true});
 }finally{await service.stop();await model.stop();}
});
