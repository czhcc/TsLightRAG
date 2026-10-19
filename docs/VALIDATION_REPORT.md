# S11 本地完整验收报告

日期：2026-10-19（Asia/Shanghai）。目标基于 S10 提交 `4cc451d0fc0a0f29af6b21082b95519b85b9c0d4`；本阶段的源文件、锁文件与 runner 结果摘要见 [机器记录](reference/s11-validation.json)。固定上游：`HKUDS/LightRAG@aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。

## 验收范围与环境

本轮验收针对 Linux 本地单用户应用、F01–F13、A01–A17 及 G01–G12 的最低对照断言。使用 Node 24.19.0、npm 11.9.0、TypeScript 6.0.3、Chromium；实际文件系统为 overlayfs，Linux 6.18.55 x86_64。测试最大 3 个 Vitest worker，Playwright 为 1 worker；没有扩展到无关平台或真实模型质量测试。

从更新后的 package-lock 执行 npm ci；原生模块编译缓存位于仓库忽略的 `.cache/node-gyp`。新增 `@vitest/coverage-v8@5.0.4` 仅用于验证。独立参考工具使用 Python 3.12、numpy 2.3.5、json-repair 0.58.6、tiktoken 0.12.0，安装到 `.tools/reference-python`；Python 不进入应用、文档解析或模型调用路径。

## 运行结果

正式命令为 `npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:unit`、`npm run test:protocol`、`npm run test:integration`、`npm run test:coverage`、`npm run test:e2e` 和 `npm run test:reference`。测试脚本包含其要求的构建；原始 runner JSON 在 `.tools/s11-*.json`，覆盖率在 `coverage/`。以下结果由本轮机器记录汇总，不累加有交集的测试类别。

| 类别 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| 单元/组件（含协议） | 267 | 0 | 0 |
| 独立协议命令（单元子集） | 36 | 0 | 0 |
| 集成 | 205 | 0 | 0 |
| 全部基础测试（覆盖率运行） | 472 | 0 | 0 |
| Chromium E2E | 10 | 0 | 0 |

全部基础测试为 **71 个文件 / 472 项**，E2E 无 flaky；五组固定 SHA 参考均逐字重生成一致。核心覆盖率 **lines 98.17%、branches 83.51%**，门槛通过。

最终复核加强了 naive 共同输入的正文/文件名、文本块与引用比较，类型检查及该参考集成文件 **17 项复测通过**，未增加测试总数。

覆盖率只统计 `storage/`、`indexing/`、`retrieval/` 核心实现，排除测试；门槛固定为 lines ≥85%、branches ≥80%。不把该数字称为全仓库覆盖率。子进程内维护 CLI 的执行不会自动计入父 Vitest 的 V8 覆盖率；其行为另由真实进程测试验证。

## 本轮发现与修正

完整上游 `extract_entities` 对照揭示 TS 在补充抽取时直接采用后一轮描述；较短和等长描述会覆盖原有证据。已改为严格更长才替换、等长保留首次值，按 Unicode code point 计数匹配 Python `len`，覆盖实体和无向关系。新增独立参考失败用例及 Unicode 回归，不降低断言。

抽取缓存身份增加 `gleaning-longest-v2` 策略标识，避免新任务复用旧策略缓存；持久化贡献 schema 不变，原快照可以继续加载。历史索引不会被自动重处理或产生模型费用；需要更新历史描述时由用户明确执行重新索引。

修正旧集成测试对 `.tools` 预先存在的依赖：写诊断前自行 mkdir，使新检出也能运行。Python 参考清单序列化使用稳定键顺序，避免仅由 set 遍历顺序造成的 fixture 字节差异；五组参考最终均可重复生成完全相同的文件。

## F01–F13 功能证据

| 功能 | 实现与本轮验证入口 | 观察及边界 |
|---|---|---|
| F01 模型配置 | models/config、client；config/protocol/models-api；models/application E2E | 三个独立地址实际收到请求；候选测试与保存分离，密钥三态、遮蔽、版本冲突、重启保留 |
| F02 文档管理 | documents/service；documents/jobs/reindex/delete；documents/maintenance/application E2E | 文件/粘贴/拖放、服务端过滤分页、真实状态、取消重试、确认删除、版本替换 |
| F03 本地解析 | parsers；formats/security/no-network；九格式真实 fixture | TXT/Markdown/HTML/CSV/JSON、文本 PDF、DOCX/XLSX/PPTX 本地成功；坏/空/扫描/超限明确失败 |
| F04 token 分块 | core/chunker/tokenizer；chunker tests | Unicode、末尾、重叠、稳定 ID 与窗口上限；检索共用本地计数 |
| F05 图谱抽取 | indexing/extraction/merge/summary；full-algorithm-reference | 完整上游初次/补充、合并、摘要触发和 map/reduce 对照；严格 JSON 与适配差异见下文 |
| F06 本地索引 | storage、indexer；indexing/snapshot/vectors | 三类向量、贡献账本、引用完整性及文档 processed 原子发布 |
| F07 五模式检索 | retrieval；retrieval-modes/kg-ranking/graph-rag-reference/application | naive/local/global/hybrid/mix 的不同分支、排序、候选和融合顺序实际断言 |
| F08 重排预算 | retrieval/context、models/client；rerank/context-budget | 实际改序、禁用零调用、fail/fallback-with-warning、最终预算及截断 |
| F09 回答与引用 | generation；generation/ndjson/stream-cancel/reference；generation/application E2E | 最终上下文实际送入模型，流式/非流式、停止/断连、唯一终态、引用及缓存；历史输入通过 API 验证，页面不持久保存对话 |
| F10 图谱界面 | graph API、GraphViewer；graph-api/GraphViewer/application | 名称/关系搜索、100 节点/300 边上限、一层邻居、属性、真实来源和文档跳转；SVG 展示不含拖拽/缩放 |
| F11 来源一致性 | indexing/maintenance；full-algorithm-reference/delete/reindex/query-cache | 共享删除重建、旧版本保留、缓存失效，当前图/向量/新查询无已删贡献 |
| F12 恢复 | storage/snapshot/recovery/writer-lock；crash/restart/lifecycle | 真实 SIGKILL、坏盘和版本拒绝、显式恢复、第二写者拒绝、中断任务保留且不自动调用模型 |
| F13 测试与运行 | npm scripts、参考 runner、生产/开发进程及保存配置 | 无真实模型 key 的完整本地验证；模型效果、其他平台和发布恢复不由本轮推断 |

## G01–G12 核心算法对照

这里的通过指本项目定义的共同夹具与最低断言，在明确适配后通过；不是全部 Python 服务、所有输入或真实模型向量/答案的逐字等价声明。

| 门槛 | 固定上游执行证据 | TS 对照与结果 |
|---|---|---|
| G01 抽取/gleaning | S11 完整 `extract_entities`、JSON 解析及规范化函数；空、短/长/等长、新增补充五组 | `full-algorithm-reference` 实际 HTTP 模型两轮与 `extraction.test`；实体/关系/补充次数一致，修正描述选择后通过 |
| G02 合并/摘要/权重 | S11 完整 `_merge_nodes_then_upsert`、`_merge_edges_then_upsert`、`_handle_entity_relation_summary`、`_summarize_descriptions`；另保留 S06/S07 权重分支 | 节点类型、描述集合、来源、关键词、权重及重试；空/单条/7/8 条/token 阈值/map-reduce 六组，独立 Python BPE 与 JS 计数及模型调用数一致 |
| G03 关键词驱动召回 | S08 完整 `kg_query` 空关键词分支、`_perform_kg_search`、关键词规范化 | keywords/query-data/retrieval-modes；高层关系、低层实体、短 query 回退与长 query 无结果 |
| G04 local 排序 | S08 完整 `_get_node_data`、`_find_most_related_edges_from_entities` | kg-ranking/graph-rag-reference；实体向量序、端点度数和、weight 降序一致 |
| G05 global 关系/端点 | S08 完整 `_get_edge_data`、`_find_most_related_entities_from_relationships` | 关系向量序、端点去重和首现顺序一致 |
| G06 hybrid/mix | S08 完整 `_perform_kg_search` | local/global 交错、mix 独立块召回；32 种 mode/method/related 组合对照 |
| G07 VECTOR/WEIGHT | S08 完整两类来源选择及 quota、vector similarity、weighted polling | kg-chunk-selection；默认 VECTOR、0/1、ties-to-even、频次、去重/排除、配额、缺向量回退 |
| G08 三路文本融合 | S08 完整 `_merge_all_chunks` | vector→entity→relation round-robin，全局去重和精确候选顺序 |
| G09 预算与引用 | S08 完整 `_apply_token_truncation`、`process_chunks_unified` 及引用/渲染函数 | 0/1/80/160/大预算、重排后 topK、文本预算与最终引用；TS 额外校验完整消息与输出预留 |
| G10 三类向量索引 | S08 原始 VDB 内容表达式；S11 完整 merge/rebuild 实际 VDB 写入 | indexing/vectors/embedding-switch/full-reference；三库 ID 映射、来源、内容规则、归一化和空间原子绑定；内容格式差异显式保留 |
| G11 来源撤销/重建 | S11 完整 `rebuild_knowledge_from_chunks`、缓存读取/解析、两类单项 rebuild | 实际 TS 删除 A/B，比较存活图、描述/来源/权重，检查三类向量和新查询来源；删除任务与崩溃一致性另由真实进程验证 |
| G12 上下文回答/引用 | S09 完整 `kg_query` 六组，S11 完整 `naive_query` 有证据/空库两组 | generationMessages/reference/API/NDJSON；最终上下文、历史、问题确实进入模型，空库零回答调用，引用来自最终证据 |

TS 对应实现的完整路径按 G01–G12 记录在机器结果的 `algorithmEvidence`，包括 `indexing/extraction.ts`、`merge.ts`/`summary.ts`、`retrieval/service.ts`/`algorithms.ts`/`context.ts`、`indexing/indexer.ts`/`maintenance.ts`、`storage/vectors.ts` 和 `generation/service.ts`。

执行方式：先按 [参考说明](../scripts/reference/README.md) 准备固定源码和验证依赖，再运行 `npm run test:reference`。S06–S11 fixture 记录原源码 hash；S11 还记录完整函数 hash、实际执行函数名、共同输入和词表 hash。参考结果来自原 Python AST 完整函数，不从 TS 的结果生成期望值。

参考端口包括固定模型输出、禁用的模型缓存传输、内存 graph/KV/vector 存储、锁及状态日志。G11 把文档撤销后的剩余来源集作为明确的存储输入，实际执行完整上游 rebuild/缓存解析与聚合；不声称运行整个上游服务器或删除 router。TS 则通过真实删除 API 验证来源撤销、物理索引与新查询结果。

## 保留的适配差异

- TS 使用严格 JSON、1 次修复/1 次补充、NFKC/空白规范化和显式端点校验；不复现上游全部宽松 JSON 修复、名称清洗和坏行跳过。标准 JSON 默认 strength=1；显式非负 strength 为目标端扩展。
- 目标持久化以块级原始贡献为权威；描述采用稳定块顺序，图合并对照按描述/来源集合归一化。检索候选、文本块和引用顺序仍逐项精确比较，没有排序后掩盖召回顺序差异。
- 摘要参数对齐为 500 tokens/8 描述/8192 context 进行共同用例对照。TS 另有完整消息预算、无进展失败和截断拒绝；不等同于上游所有可配置策略或降级分支。
- TS entity embedding 文本额外包含类型，relation 文本顺序和 ID/哈希格式也不同；G10 比较各自声明的内容构成及映射，不承诺向量输入字节或实际供应商返回向量相同。
- naive 使用统一的目标回答模板与预算，非上游专用 naive 模板的逐字复制；两端最终证据、引用身份映射、问题和历史的传递均有独立执行证据。
- 删除时原始贡献或私密配置版本缺失会明确失败，不采用可能保留已删描述的降级回退。目标回答缓存纳入历史，且只缓存无警告、完整成功交付结果。
- 图谱为限量 SVG，无手工图谱 CRUD、力导布局或无限全图。首版仍为 Linux 本地单写者、全量内存/快照，不保证 NFS、集群或物理掉电语义。

## A01–A17 强制场景

A01–A03 由 health/models-api/config/protocol 及 models/application E2E 覆盖；A04–A05 由九格式真实解析、安全预算、network probe 和上传测试覆盖；A06–A08 由去重、取消/重试、原子提交、共享删除和完整 rebuild 参考覆盖；A09–A14 由五模式/重排/预算/引用/流/空间切换/缓存覆盖；A15 由 writer-lock、坏盘/未知 schema、恢复和进程故障覆盖；A16 为本轮 lockfile 重装及真实 UI/API 闭环；A17 为上述逐 G 算法参考矩阵。具体本轮文件及通过/失败/跳过数见机器记录。

解析禁网验证与模型协议验证分开：parser Worker 禁用 HTTP(S)/TCP/TLS/DNS/UDP/fetch/WebSocket 入口，九格式仍可解析；HTML/Markdown/Office 外链请求陷阱保持零请求。该机制不是 OS 恶意代码沙箱或整个机器断网。模型阶段的配置端点确实收到请求，跨地址重定向、metadata/link-local 等不允许目标由模型 URL/HTTP 测试拒绝；没有将“只允许配置端点”误称为整个主机网络隔离。

## 可复用环境与外部状态

当前机器：安装、参考重生成、生产启动、Vite 同源代理和真实应用浏览器测试已验证。`./data` 的原 generation 保留，没有清空库或配置真实模型。

运行配置：`install_script` 和 `start_skill` 已通过配置工具确认保存，仓库内可审阅副本为 [s11-environment.json](reference/s11-environment.json)。已实际执行保存的安装脚本，完成 lockfile 安装、构建、固定上游检查、验证工具安装和五组参考重生成。Python 依赖仍只属于开发验证。

开发关闭时，这个 runner 的外层终端 SIGINT 没有传到 concurrently，首次紧接着启动生产被正确以 STORAGE_LOCKED 拒绝。给本次启动的确切 concurrently supervisor PID 发送 SIGTERM 后，两端口均关闭；生产服务随后成功启动。该已验证关闭步骤已写入 start_skill，没有使用广泛 pkill 或停止其他用户进程。

配置发布：尚未执行；用户需要在环境设置审阅、保存并发布。新任务恢复：尚未验证。以上两个状态不被当前机器运行或草稿持久化替代。

真实外部模型供应商兼容性、真实生成质量、非 Linux 文件系统/平台、物理掉电、云环境发布及新任务恢复均未验证。它们不会被记为通过，也不以缺少个人模型密钥阻止本地协议夹具验收。S12 的最终许可、使用文档和交付审查仍待执行。
