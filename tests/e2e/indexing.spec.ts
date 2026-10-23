import { test, expect } from '@playwright/test';
import { startService } from '../helpers/owned-service.js';
import { startFakeModel } from '../helpers/fake-model.js';
import { kgHandler } from '../helpers/indexing.js';
import { textProfile, embeddingProfile, bindings } from '../helpers/model-profiles.js';
test('configured browser import reaches persisted processed state through real model HTTP', async ({page}) => {
  const model = await startFakeModel(kgHandler); const service = await startService(); const errors:string[]=[];
  page.on('pageerror',(e)=>{errors.push(e.message);});
  try {
    const saved = await page.request.put(`${service.address}/api/v1/settings/models`,{data:{expectedRevision:0,profiles:[textProfile(model.url),embeddingProfile(model.url)],bindings:{...bindings,rerank:null}}}); expect(saved.status()).toBe(200);
    await page.goto(`${service.address}/documents`); await page.getByRole('button',{name:'粘贴文本',exact:true}).click(); await page.getByLabel('文档正文',{exact:true}).fill('first document Alpha Beta');
    await page.getByRole('button',{name:'导入文本',exact:true}).click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true}); await expect(detail.getByText('状态：已索引',{exact:true})).toBeVisible({timeout:15000});
    await expect(detail.getByRole('button',{name:'重试任务'})).toBeDisabled();
    await detail.getByRole('button',{name:'查看解析正文'}).click(); await expect(detail.getByLabel('解析正文')).toHaveText('first document Alpha Beta');
    expect(model.requests.filter((r)=>(r.body as {input?:unknown}).input)).toHaveLength(1); expect(errors).toEqual([]);
    await page.screenshot({path:test.info().outputPath('s06-indexed.png'),fullPage:true});
  } finally {await service.stop(); await model.stop();}
});
