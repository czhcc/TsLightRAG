# S06 验证记录

日期：2026-10-16（Asia/Shanghai）。目标父提交：`aa1192ace76f0ca4517ce9c7b53fda6bde1b9497`。上游固定 SHA：`aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。

## 实现结果

- 迁入六个上游 JSON 抽取/补充/示例、摘要和关键词模板值，标版本及 MIT 许可。关键词模板的实际调用属于 S08。
- 严格 JSON/schema，接受单个完整 JSON 围栏；每轮最多 100 条，初次和补充合计最多 200 条。最多 1 次格式修复/轮、1 轮 gleaning；非 JSON、额外字段、负强度、空关键词、缺实体端点、自关系、上下文超限和截断均明确失败。补充对同一来源名称/无向端点对作完整替换，避免同一来源重复累加。
- 名称 NFKC/trim/空白折叠，保留大小写及语言；类型标准化为小写并拒绝结构性/保留值，不作语义消歧。描述清洗控制字符、HTML 实体、精确去重，短描述以 `<SEP>` 合并；单描述保留，8 个片段或 ≥500 tokens 时触发摘要；最多 8192 输入 tokens 并受配置上下文预算约束，分组至少两个、递归无进展失败，摘要截断/超长/空值失败。
- 每块保存有效贡献、模型配置版本、提示词/规范化版本与内容 hash。文档保存 chunkIds，块保存 doc/version 与位置；fullEntities/fullRelations 和 entityChunks/relationChunks 完整正反锚点，恢复时校验来源和原始贡献一致。旧 S02/S05 schema 与历史夹具仍兼容；S06 块不能缺抽取账本。
- 无向端点生成稳定实体/边 ID；新来源 strength 加到已存边权重，再以独立来源数保底，重复来源不再加。标准上游 JSON 缺少 strength 时取 1；可选 strength 为目标端扩展。实体类型按贡献计票、确定同票次序。
- chunks/entities/relations 三类向量具有内容、内容 hash、统一空间身份与归一化 float32。全文、块、原始贡献、图、双向锚点、三类向量及 processed 在一次最终完整 generation 中发布；计算期间只保存任务与有效缓存，不暴露半文档。
- 有效抽取缓存可供失败后的手动重试复用，键包含配置 revision、无密钥 profile、提示词、内容、文档版本、分块器及编码；失败/无效不缓存成功。单记录 4 MiB、当前缓存总量 128 MiB 上限，无自动 GC。旧缓存及历史快照另占磁盘。
- 两个任务可并行解析/抽取，图合并和索引发布有独立领域队列，不在 SnapshotStore 写队列内等待模型；提交前检查 corpusRevision、取消及配置版本。配置替换与最终发布共享短期队列，避免空索引模型切换与首次提交竞态。
- 文档 UI 显示抽取/向量化/提交/已索引等真实状态；无模型仍 awaiting_configuration，旧 awaiting_indexing 可手动重试。health.stage=S06，usable=false：检索问答尚未接入。

## 固定夹具与参考执行

`tests/helpers/indexing.ts` 提供输入相关的真实本地 HTTP 文本/向量协议夹具，实际经过 ModelClient、Worker、任务与磁盘快照，不在业务层 stub 掉模型适配器。

共同夹具：首篇 Alpha/Beta，第二篇 Alpha/Beta/Gamma；两篇共享 Alpha–Beta 关系（强度 2 与 3），第二篇独有 Alpha–Gamma（强度 0.2）。验收精确断言 3 实体、2 边、权重 5 与 1、共享来源 2 个、描述去重、文档锚点数量，以及 chunks=2/entities=3/relations=2 三类向量；同时覆盖单文档多个重叠块与合法空抽取。

`.tools/s06-index-intermediates.json` 保存实际图、块级贡献、正反锚点和三类向量中间产物；包含合成正文，无真实密钥，文件被 Git 忽略，其 hash 收录到机器证据。

```bash
python3 scripts/reference/s06.py /tmp/LightRAG-reference
```

脚本先校验固定 SHA，仅以 AST 选取上游原始规范化/清洗与描述去重函数、边权重分支四条赋值语句执行。人工输入为 `tests/fixtures/graph/s06-input.json`，Python 输出为 `s06-python-reference.json`，包括源码/input hash；TS `reference.test.ts` 独立比较共同名称样例、清洗后描述去重、首次新来源/重试排除/低强度下限等四种权重结果。

**参考范围有限**：没有把完整 Python 抽取、摘要、删除重建或 G03–G12 执行过的结果冒充通过。G01/G02 的完整源码门槛仍待 S07/S11；目标端严格拒绝、NFKC 命名、确定顺序及预算保护的差异见 [来源清单](UPSTREAM_PROVENANCE.md)。Python 仅为独立验证命令，不是应用运行或解析依赖。

## 故障与行为覆盖

- 同一文档内容去重不新建任务/模型调用；embedding 失败后人工重试复用有效缓存，不重复节点、来源或权重；无效抽取不缓存。
- embedding 等待/失败时块与图均不可见，corpusRevision 不变；任务保留错误和完整解析产物。
- 最终 CURRENT 发布前写盘失败保留原索引；发布后同步不确定则 fence，重开验证为完整 processed 索引，避免盲目重放。
- 最终提交前取消无贡献；索引过程中改配置使任务明确 CONFIG_CHANGED，不混合空间。
- 在索引最终提交前分别真实 SIGKILL/SIGTERM，重启保留原文/产物与 interrupted，不自动收费重跑；手动重试可利用有效抽取缓存完成。
- 贡献账本缺失、缺实体/边锚点、错误 doc→chunk 或 fullEntities 均拒绝候选快照；并行文档共享图不会覆盖其他提交。
- 浏览器配置后导入经真实 HTTP 模型达到已索引，正文可读，processed 重试禁用，无 pageerror；保留前五项浏览器回归。

## 执行结果

**最终 37 文件 / 322 测试、6 Chromium E2E 全部通过，0 失败/跳过；typecheck/lint/build 通过。** 详细计数与 hash 以 [s06-validation.json](reference/s06-validation.json) 为准。命令包括 typecheck、lint、npm test（包含 build）、Playwright 和生产启动脚本。未新增 npm 依赖，沿用 S04 冷安装证据，不宣称本阶段重新执行 npm ci 或验证真实外部模型提供商。

调试期间两次全量回归分别暴露：测试等待阈值/错误码预期不符，以及测试清理重复写 HTTP 响应；另补充了合法补充结果累计 200 条的账本上限。已修正并最终整套通过。另一次集中测试的三个冷启动用例达到测试时限，单例诊断共享图用例约 1.5 秒通过，最终仍以原 3 workers/15 秒单测上限全量通过；未提高应用预算掩盖失败。

生产服务已用 S06 构建重启，health、模型设置、九格式能力、文档/任务 API 和页面 readiness 通过；与重启前相比 generation/revision/corpusRevision 原样保留。云环境 start_skill 已保存到原配置草稿（requires_publish=true），未改 install_script、仓库、网络或密钥设置；未发布草稿，未验证新任务恢复。

## 后续边界

S07 实施删除、重新索引、按存活原始贡献重建和非空 embedding 空间切换；S08/S09 接入检索、引用与回答。摘要可能因模型变化产生不同文本；固定 HTTP 夹具只验证协议及算法控制流。完整 GraphRAG 迁移尚未验收，历史 generation、旧缓存和未引用文件仍保留，不自动清空数据。
