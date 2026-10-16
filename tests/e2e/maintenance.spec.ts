import {test,expect} from '@playwright/test';
import {startService} from '../helpers/owned-service.js';
import {temporaryDirectory} from '../helpers/temporary-directory.js';
import {startFakeModel} from '../helpers/fake-model.js';
import {kgHandler} from '../helpers/indexing.js';
import {textProfile,embeddingProfile,bindings} from '../helpers/model-profiles.js';
test('browser reindexes a version, switches vectors and deletes a document with persisted maintenance state',async({page})=>{
  const dir=await temporaryDirectory();const model=await startFakeModel(kgHandler);let service=await startService(['--data-dir',dir.path]);const errors:string[]=[];page.on('pageerror',(e)=>{errors.push(e.message);});
  try{
    const save=async(revision:number,next=false)=>page.request.put(`${service.address}/api/v1/settings/models`,{data:{expectedRevision:revision,profiles:[textProfile(model.url),embeddingProfile(model.url,next?{model:'next-model'}:{})],bindings:{...bindings,rerank:null}}});expect((await save(0)).status()).toBe(200);
    await page.goto(`${service.address}/documents`);await page.getByLabel('文档正文',{exact:true}).fill('first document');await page.getByRole('button',{name:'导入文本',exact:true}).click();
    const detail=page.getByRole('region',{name:'任务详情',exact:true});const panel=page.getByRole('region',{name:'索引维护',exact:true});await expect(detail.getByText('状态：已索引',{exact:true})).toBeVisible({timeout:15000});
    await panel.getByLabel('替换正文（可选；留空沿用原文件）').fill('first document revised evidence');await panel.getByRole('button',{name:'重新索引文档',exact:true}).click();await expect(panel.getByRole('heading',{name:/版本 2/})).toBeVisible({timeout:15000});
    await detail.getByRole('button',{name:'查看解析正文'}).click();await expect(detail.getByLabel('解析正文')).toHaveText('first document revised evidence');
    expect((await save(1,true)).status()).toBe(200);await expect(panel.getByRole('option',{name:/next-model/})).toBeAttached();await panel.getByLabel('目标向量模型').selectOption('embedding');await panel.getByRole('button',{name:'重建三类向量并切换'}).click();await expect(panel.getByText(/活动向量模型：next-model/)).toBeVisible({timeout:15000});
    await panel.getByLabel('确认删除所选内容及其索引贡献').check();await panel.getByRole('button',{name:'删除当前文档'}).click();await expect(page.getByText('共 0 个文档',{exact:true})).toBeVisible({timeout:15000});
    await expect(panel.getByText(/尚无活动索引/)).toBeVisible();expect(errors).toEqual([]);await page.screenshot({path:test.info().outputPath('s07-maintenance.png'),fullPage:true});
    const calls=model.requests.length;expect(await service.stop()).toBe(0);service=await startService(['--data-dir',dir.path]);await page.goto(`${service.address}/documents`);await expect(page.getByText('共 0 个文档',{exact:true})).toBeVisible();expect(model.requests).toHaveLength(calls);
  }finally{await service.stop();await model.stop();await dir.cleanup();}
});
