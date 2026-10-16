# S07 验证记录

日期：2026-10-16（Asia/Shanghai）。父提交：`0d58ceb`。上游固定 SHA：`aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。

## 已实现

- 删除与清空：从候选状态撤销目标文档/块/原始贡献，对受影响共享实体和边从存活原始贡献重算类型、描述、关键词和权重；仅重新生成必要向量。没有存活来源的节点、边和对应向量一起移除。完整清空无需模型调用。
- 重新索引：可沿用原文件或替换 TXT/Markdown 正文；文档 ID 保持，成功时 version+1、新贡献替换旧贡献，不向旧权重叠加。后台任务独立于已发布文档状态，失败/取消/中断时原 processed 版本继续可读。历史解析产物按自身文档版本校验，不误套最新版本。
- 三类向量重建：保存的 embedding profile 是候选；只有全量 chunks/entities/relations 向量均通过协议、维度、空间和引用校验，才在一个 generation 中发布新向量与活动绑定。不同维度、同维不同模型和同名 operatorRevision 均走同一流程。
- 模型版本：快照记录 profileId/configRevision/spaceId；修改候选不改变活动索引。旧配置在替换 app.json 前以私有 immutable 版本文件持久化，目录 0700、文件 0600。新导入和删除使用活动 embedding，重建使用指定候选；`captureIndex` / `embeddingForSnapshot` 将一个稳定读快照配对到其模型版本。活动/任务仍使用的 profile ID 不可提前移除。
- 并发：导入、删除、清空、重新索引和向量切换共享最终提交门。解析、摘要、向量请求均在提交门和 SnapshotStore 写队列之外；提交前核对 corpus/config/document 版本与取消。普通导入最多三次计算共享候选，解决并发提交冲突；维护基于用户确认的 corpusRevision，冲突明确失败，不悄悄删除后来写入的内容。
- 完整发布：索引、文档版本/状态、贡献锚点、活动绑定、维护成功和文件释放任务原子提交。内容/空间变更递增 corpusRevision，进度与清理记账不递增；删除/重建清除当前抽取及未来检索/回答缓存。
- 文件释放：持久 pending/retained/failed/done 任务可启动恢复、手动重试。CURRENT 发布前绝不释放；引用检查包含保留 generation 的原文/产物引用，并核对 manifest 中的 KV/status checksum。损坏/不完整历史不能证明可释放时保留文件。源文件/产物父目录拒绝 symlink，不递归删除未知目录内容。
- WebUI：文档页提供替换正文、重新索引、带显式勾选的删除/清空、保存候选后的全量向量切换、维护取消/重试和文件释放状态。模型页说明候选与活动版本的区别。仍无检索或回答能力，health.stage=S07、usable=false。

## 应用 API

所有维护写请求要求 JSON、同源/loopback，并使用当前语料/配置版本；文档操作另需当前文档版本。返回 202 表示任务持久接受，不表示操作已成功。

| 接口 | 请求与行为 |
|---|---|
| `GET /api/v1/maintenance` | corpusRevision、维护任务、文件释放任务、遮蔽密钥的 activeIndex |
| `DELETE /api/v1/documents/:id` | expectedCorpusRevision / expectedConfigRevision / expectedDocumentVersion；删除单文档 |
| `DELETE /api/v1/documents` | expectedCorpusRevision / expectedConfigRevision；清空全部文档 |
| `POST /api/v1/documents/:id/reindex` | 三个版本字段；可选 replacement: {name,text}，限 TXT/Markdown |
| `POST /api/v1/maintenance/rebuild` | expectedCorpusRevision / expectedConfigRevision / targetProfileId；全量切换 |
| `POST /api/v1/jobs/:id/cancel` | 保持原有幂等取消及提交胜出语义 |
| `POST /api/v1/jobs/:id/retry` | 维护重试需当前版本和目标 profile；创建一个后继，不自动收费重试 |
| `POST /api/v1/documents/:id/retry` | expectedJobId；沿用导入重试，也可重试该文档最近失败的维护 |
| `POST /api/v1/maintenance/cleanup` | 重试已持久化的文件释放计划，不扩大删除范围 |

全库重建/清空要求先结束已有执行任务，并阻止新的导入/维护入队；单文档维护允许其他文档提交。重复维护重试返回同一后继，失效版本 409。原文、产物、文档与历史任务上限继续沿用 S05；替换后的当前原文配额与产物接受记账经同一串行入口校验。

## 行为与故障验证

- 删除 A/B 任一篇，保留另一篇完整共享来源、描述/关键词、向量；共用边权重从 5 降到存活来源 3 或 2，而非冻结旧值；独有节点/边按来源消失，旧读快照仍自洽。
- 最后文档删除和全清空后，三类向量/图/块/贡献/缓存无孤儿，活动绑定释放；历史原文仍有引用时保留。
- 重新索引成功原子替换版本和原文；embedding/解析失败、取消、语料冲突保持旧完整版本。其他文档可以在维护计算期间提交，维护拒绝旧候选后可在新语料上重试。
- 不同维度、不同模型及 operatorRevision 的三类向量同时切换；第二批失败不切换。保存候选新密钥后，新导入仍在实际 HTTP 请求中使用旧活动模型/旧密钥；被引用 profile 删除返回 409。
- 活动读快照保留自己的模型版本；切换后从候选设置移除旧 profile，旧读者仍可正确匹配原空间；给旧向量传新空间 ID 会失败。活动配置归档缺失时拒绝启动，不丢弃语料。
- 删除及切换在最终发布前后分别真实 SIGKILL，重启为旧完整索引或新完整索引，不出现半删除/混合空间；遗留任务 interrupted，不自动重跑/收费。
- 删除 CURRENT 发布前/后注入写盘失败；前者旧文档保持，后者存储 fence。发布后清理任务仍可恢复。
- 文件释放首次因保留快照 retained；仅在测试自己的临时目录中显式退役历史后，验证 symlink 路径拒绝、修复后重试成功。应用未自动删除历史 generation。
- Chromium 经真实本地 HTTP 模型完成导入→替换正文/版本→全量向量切换→删除→重启保留，并检查无 pageerror；原有浏览器回归保留。

## Python 参考与来源

```bash
python3 scripts/reference/s07.py /tmp/LightRAG-reference
```

校验固定 SHA 后执行 `_rebuild_single_relationship` 的原始两条 weight 赋值 AST，生成四个存活证据夹具：3、0.2、0.2+3、2+3；结果分别 3、1、3.2、5。`maintenance-reference.test.ts` 与 TS 存活贡献重算对照，记录源码 hash。使用现有 S06 提示词和 MIT 许可，来源详见 [UPSTREAM_PROVENANCE](UPSTREAM_PROVENANCE.md)。

此参考只补充 G02 非退化删除重建权重分支；没有宣称完整 Python 删除、摘要或 G01–G12 参考验收全部通过。目标端严格拒绝缺贡献的共享图，不保留可能带已删事实的降级描述。

## 检查与限制

**最终 45 文件 / 348 测试、7 Chromium E2E 全部通过，0 失败/跳过；typecheck/lint/build 通过。** 首轮 345 项通过后，按短期提交互斥要求调整计算/提交边界，补充配置读快照与解析失败覆盖，最终全量再次通过。命令、源文件/构建/报告 hash、生产 readiness 与环境草稿状态见 [s07-validation.json](reference/s07-validation.json)。未新增 npm 依赖，冷安装沿用 S04 证据；没有验证真实外部提供商或回答质量。

S07 保留历史 generation、配置凭据版本及其仍引用的原文/产物，不承诺物理擦除，也不提供自动 GC。旧模型 endpoint/model 的实际权重由提供者维护，operatorRevision 是显式空间声明，应用不能检查远端内部权重。Linux 本地文件系统、单写者约束仍适用，未知/损坏状态不静默回退。

生产服务已用 S07 构建重启，健康、模型设置、九格式能力、文档/维护 API 与页面 readiness 通过；重启前后的 generation/revision/corpusRevision 保持一致，未对生产数据执行删除或重建。云环境 start_skill 已保存到原草稿（requires_publish=true），安装/仓库/网络/密钥设置未改；未发布草稿，未验证新任务恢复。

下一阶段 S08 实施五种检索模式、图来源块选择、重排、预算与引用；S09 实施回答和流。当前索引维护完成不等于知识库问答已可用。
