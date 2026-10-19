# LightRAG 代码转移实施步骤

## 1. 执行约定

本步骤文档对应 [LightRAG代码转移实现方案](LightRAG代码转移实现方案.md)。目标为 TypeScript 本地单用户 Web 应用，功能范围为方案 F01–F13；不是把上游全部功能或 SDK 翻译一遍。

- 上游：<https://github.com/HKUDS/LightRAG>，固定提交 `aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。
- 目标：<https://github.com/czhcc/TsLightRAG>。
- 状态日期：2026-10-19。
- **当前 S00–S11 已完成本地范围；S11 为 472 项基础测试和 10 项 E2E 通过，见 [完整验收报告](VALIDATION_REPORT.md)。** G01–G12 共同夹具最低断言按已声明适配通过；下一步 S12，发布/新任务恢复及真实供应商等未验证。当前与历史结果见 [实施状态](IMPLEMENTATION_STATUS.md)、[S09](S09_VALIDATION.md) 和 S01–S08 验证记录。
- 不创建额外 Git worktree。开发前检查目标仓库 instructions 和 Git 状态，保留用户改动。
- 不要求模型/数据库/端口环境变量；不引入远程解析器、Python 服务或外部数据库。
- 每个功能批次都包含实现、自动化测试和实际结果记录；不得先完成所有业务代码，再统一补测试。
- 每阶段完成后独立本地提交并更新状态；推送远端必须有用户明确指令。初始方案阶段只编写文档，后续按用户指令提交和推送，不将文档交付视为功能实施完成。

## 2. 阶段总览与依赖

| 阶段 | 主题 | 依赖 | 当前状态 |
|---|---|---|---|
| S00 | 固定源码、结构分析与范围设计 | 无 | 分析、方案及初始来源清单已完成；后续实际移植继续补充来源 |
| S01 | TypeScript 工程和测试基座 | S00 | 已完成；71 项测试、1 项浏览器 E2E，冷安装与开发代理验证通过 |
| S02 | 文件持久化内存存储与快照 | S01 | 已完成；121 测试 + 1 浏览器，含 10 个真实 SIGKILL 边界和原生 flock |
| S03 | 无环境变量配置与模型协议 | S01、S02 | 已完成；197 测试 + 3 浏览器，含独立地址、密钥三态和候选测试 |
| S04 | 本地文档解析与 token 分块 | S01、S02 | 已完成；263 测试 + 4 浏览器，九格式真实夹具、禁网 Worker 与分块 |
| S05 | 持久化任务和文档管理 | S02、S03、S04 | 已完成；288 测试 + 5 浏览器，导入/持久化/取消重试/重启 |
| S06 | 抽取、合并和三类索引 | S02、S03、S04、S05 | 已完成；322 测试 + 6 浏览器，原始贡献/三类向量/原子发布和故障恢复 |
| S07 | 删除、重试、重建及向量空间切换 | S05、S06 | 已完成；348 测试 + 7 浏览器，共享贡献/版本替换/原子切换/故障恢复 |
| S08 | 五模式检索、重排、上下文和引用 | S03、S06、S07 | 已完成本阶段范围 |
| S09 | 回答生成、NDJSON 流、取消和缓存 | S05、S08 | 已完成本阶段范围 |
| S10 | WebUI 和真实应用联调 | S03–S09 | 已完成；限量图谱、来源追溯、拖放/过滤、安全 Markdown 与完整浏览器闭环 |
| S11 | 构建启动、故障恢复和完整验收 | S01–S10 | 本地验收通过；G01–G12 适配对照、472 测试/10 E2E、覆盖率与可复用配置；发布/新任务恢复未验证 |
| S12 | 来源许可、使用文档和交付审查 | S11 | 未开始 |

实施顺序以表格依赖为准。S03/S04 在存储基础稳定后可独立推进，UI 组件也可提前开发，但不能把 mock 页面截图作为实际后端验收。本计划不依赖多代理协作。

## 3. S00：固定上游与行为清单

### 工作

1. 固定上游 SHA，记录源码版本、MIT 许可和读取日期；不跟随默认分支自动变更设计。
2. 逐项维护 F01–F13：上游路径/符号 → 目标模块 → 测试 → 差异 → 当前状态。
3. 记录未迁移能力：外部存储、远程解析、SDK、多进程、多模态、手工图谱 CRUD 等。
4. 实施时新增 `docs/UPSTREAM_PROVENANCE.md`：列实际复用文件/提示词/夹具的原路径、SHA、目标路径、修改和许可证，不仅写一个笼统来源链接。
5. 建立 `docs/IMPLEMENTATION_STATUS.md`，从“计划”开始，不把已有两份文档标成应用完成。
6. 将实现方案 §8.4 的 G01–G12 作为核心图谱算法保真清单；记录参考算法夹具的来源和生成过程。当前清单为待实现，不代表代码已经移植。

### 源码依据

阅读 `lightrag/lightrag.py`、`pipeline.py`、`operate.py`、`base.py`、`prompt.py`、`llm_roles.py`、`kg/` 四类默认存储、`parser/`、`api/routers/`、`lightrag_webui/src/` 及对应 tests。

### 验收

两份计划可以相互导航；SHA、来源路径、首版范围与排除项一致。后续实现不凭印象把 LightRAG 简化为只做 chunk embedding 的 NaiveRAG。

## 4. S01：工程、契约与测试基座

### 工作

1. 建立 npm workspaces：`apps/server`、`apps/web`、私有 `internal/contracts`；不配置 SDK 发布入口。
2. 固定 Node 24，TypeScript strict/ESM；确认 React/Vite/Fastify/测试工具在该工具链兼容后提交 lockfile。
3. 创建 shared schema：model profile、document/job、entity/relation、query、citation、API error、NDJSON discriminated union。
4. 配置服务端真实启动、WebUI 同源代理、构建与静态资源服务；CLI 接受 host/port/data-dir/config。
5. 建立临时目录、子进程服务、本地假模型 HTTP 服务器和测试 fixture 工具；测试端口动态分配，清理只针对测试创建的进程和目录。
6. 忽略 data、上传文件、密钥配置、node_modules、dist、coverage；提交必要小型文档夹具和可审查的 golden 结果。

### 同步生成的测试

- `contracts.test.ts`：非法输入、缺字段、超限、NDJSON 联合类型。
- `cli.test.ts`：默认值、参数覆盖、未设置业务环境变量启动、非 loopback 拒绝。
- `health.integration.test.ts`：真实服务路由与未配置模型时的状态，不把端口开放等同于可用。

### 验收

新增命令可实际执行：`npm ci`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm test`。首次覆盖非零有效测试；无模型 key 的服务可运行并显示待配置状态。

## 5. S02：本地 KV、向量、图和原子快照

### 工作

1. 实现内存 KV、文档状态表、Float32 向量表与无向图；先测试独立存储，再连接协调器。
2. 向量实现数量/维度/有限值/零范数检查、归一化、cosine、阈值、精确 top-k、稳定同分排序；分开三类 namespace。
3. 实现固定 `default` 工作区、引用类型、贡献表的基础容器和 schemaVersion。
4. 实现 manifest/checksum、新 generation、fsync、CURRENT 原子发布、读快照捕获和提交结果语义。
5. writer lock 拒绝第二进程；活动锁不能只按年龄被抢占，孤儿锁有可验证恢复路径。
6. 新快照发布成功才切换可见内存；corpusRevision 与一般 generation 分开。任务提交在最新代应用增量，不覆盖其他任务成果；共享数据版本变化时退出锁重算。向量以 number[] 写 JSON、按维度恢复 Float32Array。
7. 实现启动验证、未知版本拒绝、损坏不覆盖和显式恢复操作说明。

### 同步生成的测试

- `kv.test.ts`：增删查、复制隔离、空/不存在、Unicode。
- `vectors.test.ts`：手算向量、负相似度、同分、阈值、top-k、NaN/Infinity/零向量及非法维度。
- `graph.test.ts`：无向边归一化、邻接/度数、删除、无悬空边。
- `snapshot.integration.test.ts`：实际文件重开，generation/manifest/checksum 和 schema；并发任务、缓存与进度提交不覆盖彼此；向量 JSON 往返数值误差在明确容差内。
- `snapshot-crash.integration.test.ts`：在写 namespace、manifest、CURRENT 前后注入异常，真实子进程 SIGKILL 后只读到旧/新完整代。
- `writer-lock.integration.test.ts`：第二进程拒绝、活动锁不抢占、已退出拥有者恢复。

### 验收

可证明“已提交”数据重启保留、I/O 错误不报成功、未提交内存不被查询、损坏文件不清空重建。此门槛未过不得开始图谱业务写入。

## 6. S03：本地配置与模型 HTTP 适配

### 工作

1. 配置来源为默认值/本地 app.json/CLI，业务无 `process.env`/dotenv 依赖；无配置也可启动。
2. 定义 profile、extract/keyword/query 角色绑定、独立 embedding 和可选 rerank；默认抽取/关键词复用 query。
3. 实现遮蔽 GET、expectedRevision 保存、密钥省略保留/null 删除/字符串替换、受限权限及原子配置写盘。
4. 实现文本和向量 OpenAI-compatible 请求；标准 Cohere/Jina-compatible rerank 请求。
5. 完整区分 baseUrl 拼接与 rerank 完整 endpoint；限制 URL、重定向、响应大小，保持 TLS 校验。
6. 实现连接测试，使用未保存候选配置发送小型真实协议请求；不修改索引或悄悄保存配置。
7. 实现限流、超时、AbortSignal、有限退避、429 Retry-After 和安全错误；API key 只留服务端。
8. 产生版本化配置和 embeddingSpaceId，定义 operatorRevision；S07 完成非空库激活流程。

### 同步生成的测试

- `config.test.ts`：初始未配置、持久化、revision 冲突、写失败、密钥三态更新、禁止回传密钥。
- `model-url.test.ts`：`/v1`、反向代理前缀、结尾斜杠、不允许的 scheme/userinfo/metadata 目标、禁止跳转泄密。
- `chat.protocol.test.ts`：断言 model/messages/headers/body，JSON、401、429、超时、空返回及分包 SSE。
- `embedding.protocol.test.ts`：乱序 index、重复/缺失、维度、零/非有限值、批量和取消。
- `rerank.protocol.test.ts`：真实 index 重排、重复/越界/非有限分、禁用不调用、错误策略。
- `models-api.integration.test.ts`：保存与连接测试分离、候选地址实际收到请求、日志/响应不含合成测试密钥。

### 验收

用三个不同的本地 HTTP 端点分别完成文本、向量和重排测试；不设置任何业务环境变量。外部真实提供商尚未验证时明确记录，不以假模型测试宣称兼容所有供应商。

## 7. S04：本地文档解析与分块

### 工作

1. 定义 ParsedDocument/ParsedBlock，保留页、段、标题、表、工作表、幻灯片等可用定位与警告。
2. 先做 UTF-8 TXT/Markdown，再做 HTML/CSV/JSON；禁用所有资源下载。
3. 做 PDF 文本层、DOCX 段落表格、XLSX 工作表/公式缓存、PPTX 文本/表格与数值排序。
4. 对 ZIP/XML 先执行项数、解压大小、深度和路径预算，再交给解析库；Worker 限时/限资源。
5. 本地 tokenizer 固定 encoding/version；实现窗口及 overlap、块序号和 source location 映射；检索预算共用计数器。
6. 显式处理空文档、编码错误、扫描 PDF、加密 Office/PDF 和未知扩展名；不转成空成功。
7. 输出并展示格式能力矩阵；不承诺 OCR、smart heading、公式/图片语义和版面逐像素还原。

### 同步生成的测试

- `parsers/<format>.test.ts`：每种格式的正常、中文、空/坏文件和位置 golden。
- `office-content.test.ts`：DOCX 段落与表格顺序、XLSX 公式结果/无缓存警告、PPTX slide2/slide10 数值排序及组形状。
- `parser-security.test.ts`：路径穿越、ZIP bomb、XXE、超深结构、宏不执行、超时终止。
- `parser-no-network.test.ts`：在无模型调用阶段禁止全部出站流量，包含 HTML/Markdown 外链与 Office 外部关系。
- `chunker.test.ts`：中英文/emoji、窗口上限、0/过大 overlap、空输入、稳定 ID、不会丢末尾或形成无限循环。

### 验收

格式矩阵中每个首版格式都有真实小文件夹具，不只用内存字符串模拟 Office。解析阶段不产生任何外部请求，默认分块稳定且在声明 token 限制内。

## 8. S05：文档和持久化任务

### 工作

1. 实现 multipart/文本导入，按 hash 去重；显示名与磁盘存储键分离。
2. 原文件落盘并持久记录后才返回 202；缺模型时允许解析但停在明确的 awaiting_configuration。
3. 实现方案中的任务状态机，记录 attempt、配置版本、当前阶段、警告、错误和取消标志。
4. 控制并发与背压；CPU 解析跑 Worker，异步模型请求有独立限流；不要把主事件循环阻塞成不可查询。
5. 实现分页文档列表、详情、进度查询、手动重试和任务取消；重试幂等。
6. 服务退出时停止接收任务、取消在途调用并持久化可恢复状态。重启将残留执行态标为 interrupted，不自动收费重跑失败任务。

### 同步生成的测试

- `documents-api.integration.test.ts`：上传/粘贴、重名异内容、同 hash 去重、限额、非法文件名/软链接。
- `jobs.integration.test.ts`：真实阶段转换、缺配置、失败 retry、重复 retry、不自动重试失败。
- `jobs-restart.integration.test.ts`：202 后立刻重启仍有原文件和任务；执行中断后可手动恢复。
- `cancellation.integration.test.ts`：队列、解析、模型、提交前取消及提交竞争，不出现虚假成功或重复终态。

### 验收

文档状态是真实持久化事实，不是前端进度计时器。任务失败会留下可诊断且去密的原因，重新启动不会悄悄丢弃已接受文档。

## 9. S06：实体关系抽取、合并和索引

### 工作

1. 从上游 JSON 提示词迁入实体/关系 schema、关键词/摘要模板并标记来源版本；不实现 tuple 兼容解析。
2. 实现严格 JSON 校验、代码围栏处理、有界修复/补充抽取及显式错误。
3. 为每块持久化原始有效抽取贡献，支持去重、实体规范化、无向关系端点、weight 和描述合并；按上游保留新来源 strength 累加与不同证据数下限，不能把所有权重简化为来源数量。
4. 建立 doc→chunk/entity/relation 与 entity/relation→chunk 双向账本；避免只有图上的 sourceIds 而缺文档贡献锚点。
5. 生成 chunks/entities/relations 三类向量，记录内容和 embedding 空间身份。
6. 将一个文档的最终索引及 processed 状态一起发布；只发布满足引用完整性的候选状态。
7. 抽取缓存记录模型/提示词/文档块版本；失败与无效结果不能当作成功缓存。

### 同步生成的测试

- `extraction.test.ts`：有效 JSON、围栏、错误类型、超限、补充次数、缺端点、语言和同名规范化。
- `merge.test.ts`：跨块/跨文档重复、描述去重、来源 strength 累加、证据数下限、同一任务重试不累加；对照 G01/G02。
- `contributions.test.ts`：正反引用完整、无悬空实体/边、doc 账本可完整定位贡献。
- `indexing.integration.test.ts`：真实本地假模型 + 三类向量 + 图 + snapshot；中途 embedding/写盘失败没有半文档可见。
- `index-retry.integration.test.ts`：处理同一文档两次结果一致，合理使用缓存，不新增重复节点/关系。

### 验收

用包含两篇文档、共享实体、共同关系和独立关系的固定夹具，验证实体数、边数、贡献集合、描述和向量命名空间。必须记录中间产物，不能仅断言“回答非空”。

## 10. S07：删除、重建和 embedding 切换

### 工作

1. 删除先从候选状态撤销该文档贡献，再重建共享实体/边的描述和必要向量；最后同一 generation 发布。
2. 文档重建使用新版本替换旧贡献，不向旧权重继续叠加；失败仍读旧的完整版本。
3. 对删除、清空、重建、索引提交统一写入互斥，长期模型计算放锁外并提交时验证版本。
4. 实现全量 embedding 切换：验证 profile → staging 三类向量 → 完整性检查 → 激活快照绑定。
5. 激活前旧库使用旧 profile，失败不切换；被活动快照/任务使用的 profile 或 key 不能提前删除。
6. 内容变更递增 corpusRevision，失效回答缓存；清理原文件需在发布后且确认没有其他引用，可由持久化清理任务重试。

### 同步生成的测试

- `delete-shared-entity.integration.test.ts`：删 A 保留 B 的共享节点/边和来源；描述/向量/上下文不残留 A。
- `delete-all.integration.test.ts`：最后一份贡献移除后无孤儿向量/关系；缓存不返回旧内容。
- `reindex.integration.test.ts`：新旧文档版本替换、失败回滚、取消和并发写竞争。
- `embedding-switch.integration.test.ts`：不同维度、同维不同模型、同名 operatorRevision、批次失败、重启恢复及三类向量同时切换。
- `delete-crash.integration.test.ts`：提交前后 SIGKILL、孤儿文件清理重试、无半删除可见。

### 验收

删除与重建不丢其他文档数据。新 query embedding 与所查索引永远同空间；不允许“换个模型名就直接搜索旧库”。

## 11. S08：五种检索、重排与引用

状态：已完成本阶段范围；固定 SHA 参考、显式适配差异与验证结果见 [S08 验证记录](S08_VALIDATION.md)。

### 工作

1. 实现 naive：query embedding → chunks top-k。
2. 实现关键词 JSON 抽取、缓存和高/低层关键词；local 从实体侧进入图，global 从关系侧进入图。
3. 实现 hybrid 合并、mix 的额外块向量召回；批量 embedding 只包含当前模式需要的输入。
4. 实现 local 实体向量序、邻接边 `(degree(src)+degree(tgt), weight)` 降序和 global 关系向量序；不能统一为同一排序。图候选 local/global round-robin 与最终向量/实体/关系块三路 round-robin 分开实现。
5. 重排开关/策略落地，保留原始 ID 与结果 index 对应，不把重复索引误当新证据。
6. 完整计算 system/history/query/context/answer 预算；最终引用只来自最终上下文。
7. 实现 `/query/data`、onlyNeedContext/onlyNeedPrompt，输出可验证结构和截断统计。
8. 实现图关联证据块的默认 VECTOR 和可配置 WEIGHT：有效组去重、块频次、关系排除实体块、VECTOR 配额、WEIGHT 线性配额与剩余额度重分配、Python ties-to-even、同分首次顺序和源码回退分支；默认策略 VECTOR、relatedChunkNumber=5，本地配置，不用环境变量。
9. 对 G03–G10 逐项执行参考对照；截断后的图候选顺序必须传给后续块选择，不能只对比是否返回某个 chunk。

### 同步生成的测试

- `retrieval-modes.test.ts`：为五种模式设计能产生不同候选的图/向量/关键词，断言实际访问分支和集合。
- `retrieval-order.test.ts`：阈值、同分、degree/weight、交错去重、候选为空及 mix 仅块命中的情况。
- `kg-ranking.test.ts`：local/global 不同排序、端点度数之和、local 优先图合并和向量/实体/关系块融合顺序。
- `kg-chunk-selection.test.ts`：默认 VECTOR、WEIGHT 线性配额、r 或 n 非正与 1 边界、ties-to-even、剩余分配、组去重、频次排序、同分与数据缺失回退。
- `graph-rag-reference.integration.test.ts`：固定 SHA Python 参考算法与 TS 共用模型/向量/token 夹具，对照候选及顺序、权重、证据块、截断与引用；参考结果不得来自 TS 实现自身。
- `rerank-integration.test.ts`：实际改序、禁用零调用、错误 fail/fallback-with-warning、最终 topN。
- `context-budget.test.ts`：历史与 prompt 占用、中文 token、极端预算、截断边界和实际最终提示词不超限。
- `references.test.ts`：被截断块不进入最终引用，同一文件多块聚合，可用页码/段落正确，无假引用。
- `query-data.integration.test.ts`：接口结构完整，未调用最终回答模型；关键词/向量调用单独断言。

### 验收

五种模式不能只是同一个向量查询换 mode 标签。空证据、关键词失败、图中引用缺失和重排故障都有明确结果，检索输出可复现。

G03–G10 必须有参考执行证据；只完成界面或参考环境被阻塞时，S08 的算法保真门槛仍为未通过。

## 12. S09：回答、流式取消与缓存

状态：本阶段范围已完成；实际接口、缓存边界、Python 参考与测试结果见 [S09 验证记录](S09_VALIDATION.md)。

### 工作

1. 从最终上下文构造受约束回答提示词，传入历史，要求模型使用已有引用 ID。
2. 实现非流式结果、NDJSON `meta/references/delta/done/error/cancelled` 协议；模型 SSE 在服务端解码转换。
3. 支持半包、多行、Unicode、空 delta、usage-only、超时、断流；开始发送后不自动重放生成。
4. 浏览器断开/停止触发模型 fetch 取消；提交/取消竞态遵守唯一终态规则。
5. 无上下文时返回明确未找到；异常不存在引用给出警告，不伪造来源。
6. 实现有界的关键词/embedding/回答缓存与 schema；失败/取消/部分流不缓存。
7. 回答 key 包含语料、模型、向量空间、模式、重排、预算、问题、历史、用户提示版本。

### 同步生成的测试

- `generation.test.ts`：提示词字段、历史、引用、空证据零回答调用、不存在的引用 ID。
- `ndjson.integration.test.ts`：真实 HTTP 分包、事件顺序、仅一个终态、返回非流式模型时的转换。
- `stream-cancel.integration.test.ts`：断开后上游收到取消、无重复 token、部分输出不缓存。
- `query-cache.integration.test.ts`：命中与模型/历史/预算/重排改变失效；删除/重建/切换空间失效。

### 验收

真实目标服务与假模型的分包流可被客户端逐条读取；错误、取消和正常完成不会互相冒充。缓存不能掩盖模型请求及删除一致性缺陷。

## 13. S10：界面集成

状态：已完成本阶段范围；实际实现、SVG 展示适配和测试结果见 [S10 验证记录](S10_VALIDATION.md)。

### 工作

1. 从上游 UI 选择性迁入 React 组件、图谱工具和安全 Markdown 渲染，保留来源/许可；替换 API，不照搬依赖环境变量的配置入口。
2. 模型页：文本 profile 与角色绑定、独立向量/重排地址、候选连接测试、密钥保留/清除、保存冲突和重建提醒。
3. 文档页：拖放/选择/粘贴、格式与限制提示、分页/过滤、真实任务状态、失败/取消/重试/删除确认。
4. 查询页：五模式、重排设置、流式回答与停止、来源展开、检索数据/最终上下文、无证据和错误状态。
5. 图谱页：搜索、限量子图、邻居展开、属性和来源；删除后刷新，不加载无限全图。
6. 界面提供中文为默认的可读文案；可复用上游中英结构，但不承诺首版完整多语言覆盖。
7. 不把密钥保存到 localStorage/URL/日志；引用和图谱文本严格消毒，界面不得执行文档内 HTML/script。

### 同步生成的测试

- `ModelSettings.test.tsx`：三个地址独立、角色复用、候选测试、不回显密钥、冲突/重建提示。
- `DocumentManager.test.tsx`：真实状态映射、分页、错误/重试/删除和超限说明。
- `RetrievalView.test.tsx`：逐块流、停止、模式参数、引用、无证据/部分错误。
- `GraphViewer.test.tsx`：节点数量上限、名称搜索、属性与来源，异常边不导致界面崩溃。
- `application.e2e.ts`：真实应用 + 三个假模型端点，浏览器完成配置→上传→五模式查询→图谱→共享文档删除→重启恢复。

### 验收

页面对真实目标 API 工作；没有为截图硬编码文档、图谱和回答。刷新/重开后配置与文档保留，取消与错误可见，密钥不泄露。

## 14. S11：完整验证与可复用运行环境

状态：本地范围已完成，见 [完整验收报告](VALIDATION_REPORT.md) 和 [机器记录](reference/s11-validation.json)。用户发布、新任务恢复、真实供应商和非 Linux 检查保持单独未验证状态。

### 工作

1. 从 lockfile 冷安装，执行所有类型、lint、构建、离线和浏览器检查；检查测试结果属于本轮、测试数非零。
2. 用真实应用进程执行上传、索引、五模式、重排、引用、删除、取消、重建和重启场景。
3. 禁用网络的解析验收和模型流量白名单分开执行，证明只有模型适配器调用被配置的端点。
4. 运行快照提交、删除、embedding 切换期间的进程故障测试；确认资源上限和拒绝第二写者。
5. 用固定夹具在独立验证环境执行固定 SHA 的相关 Python 参考算法，完成 G01–G12 对照；参考程序不成为目标应用运行依赖。未执行的参考对比明确列为未运行并保留验收门槛，不能降为可选以宣布算法已移植。
6. 保存实际 `install_script` 与 `start_skill`：目录、Node/npm 激活、npm ci/build、启动命令、日志位置、HTTP 业务就绪检查、已用 dataDir、仅停止拥有的进程。
7. 当前机器验证、配置草稿保存、用户发布、新任务恢复四者单独记录；不以保存脚本代替启动服务。

### 目标命令

以下是 S01–S11 的最终目标命令集合。S01 实际已执行的子集见 [验证记录](S01_VALIDATION.md)；S11 已补齐并执行 `test:protocol`、`test:coverage`，同时增加 `test:reference`；历史阶段未执行的命令仍不得回填为历史结果：

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm run test:unit
npm run test:protocol
npm run test:integration
npm run test:e2e
npm run test:coverage
npm run test:reference # 固定源码与独立验证依赖见 scripts/reference/README.md
npm start -- --host 127.0.0.1 --port 9621 --data-dir ./data
```

开发目标命令为 `npm run dev`，生产为单一服务提供 UI 与 API；CLI 路径相对目标仓库根解析并写入启动日志。禁止自动清空已有 dataDir；测试必须使用独立临时目录。

### 验收报告

生成 `docs/VALIDATION_REPORT.md` 与机器可读结果，至少记录：

- 目标提交、上游 SHA、Node/npm/依赖锁版本、OS、命令及退出码。
- 单元/协议/集成/E2E 各自通过、失败、跳过、未运行数和 skip 原因；不能混在一个“通过总数”。
- F01–F13 的实现、测试、实际观察和限制。
- G01–G12 的上游符号、TS 实现路径、参考运行命令、共同夹具、期望/实际中间结果和明确差异；算法未实现、未测试、对照阻塞与通过分别列示。
- 实际本地格式矩阵、模型协议矩阵、持久化与故障恢复结果。
- 必须列出尚未运行的真实供应商验证、真实生成质量和非 Linux 文件系统验收。
- 模型测试使用合成 key 和样本文本，报告不含真实 key、原始私有文档或完整敏感请求。

存在未解释失败不能宣布环境或首版完成。真实模型质量/未支持平台的可选检查不替代离线功能门槛，也不被虚报成已通过。

## 15. S12：许可、文档与交付审查

### 工作

1. 顶层保留适用 MIT LICENSE 和 LightRAG Team 版权来源；复用第三方库按各自许可列出归属。
2. 编写 README/README_zh 或单一中文 README，说明用途、范围、依赖、安装、配置模型、启动和运行测试。
3. 文档说明本地解析与模型外发边界、无环境变量配置、key 存储方式、数据目录和备份恢复、扫描件不支持、图谱/向量内存限制。
4. 提供不含密钥的配置示例；运行文件必须 gitignore。不要提交真实模型地址/凭据和个人上传文档。
5. 检查项目没有外部数据库驱动、远程文件解析路径、Python 业务执行入口或对外 SDK 发布配置。
6. 对照实现方案的最终门槛逐项签收，更新状态为已完成的真实范围；不将排除项补写成暗中实现。

### 验收

一个新使用者能按 README 启动服务，在界面配置模型后完成导入→检索→带引用回答→删除→重启保留状态。离线测试不要求个人密钥；若使用真实模型，其实际费用和数据传输范围明确可见。

## 16. 强制场景清单

下列场景在相关阶段就生成测试，S11 汇总复跑，不留作口头承诺。

| 编号 | 场景 | 关键断言 | 责任阶段 |
|---|---|---|---|
| A01 | 空配置启动 | 无业务 env、无模型 key 也能打开设置；索引缺配置有明确状态 | S01/S03/S05 |
| A02 | 模型地址独立 | 文本、向量、重排分别请求三个指定 HTTP 服务 | S03/S10 |
| A03 | 密钥生命周期 | GET/日志无密钥；省略保留/null 清除；重启可用；CSRF 写请求拒绝 | S03/S10 |
| A04 | 格式全本地解析 | 所有首版格式有真实夹具；禁止网络仍成功；扫描件/坏文件不空成功 | S04 |
| A05 | 安全与资源限额 | traversal/ZIP bomb/XML/外链/超时受控，上传不覆盖配置 | S04/S05 |
| A06 | 去重与重试 | 同内容复用 doc；同块不重复加 weight；失败不自动收费重跑 | S05/S06 |
| A07 | 原子索引与重启 | 成功文档所有 stores 一致；崩溃无半代，已接受任务可恢复 | S02/S05/S06 |
| A08 | 共享实体删除 | 删除 A 后 B 的证据保留，描述/向量/新回答无 A 残留 | S07 |
| A09 | 五检索分支 | naive 无图/关键词，local 实体、global 关系、hybrid 两者、mix 加块 | S08 |
| A10 | 重排和预算 | 重排真实改序；错误策略显式；最终 prompt/历史/输出预留不越界 | S08 |
| A11 | 引用可追溯 | 引用只含最终证据，定位诚实，未知 ID 警告，空库不编造回答 | S08/S09 |
| A12 | 流与取消 | UTF-8 半包正确；停止上游取消；唯一终态；部分输出不缓存 | S09/S10 |
| A13 | 空间切换 | 同维异模型也重建；三向量空间同代激活；失败仍查旧库 | S07 |
| A14 | 缓存隔离 | 模型/语料/历史/预算/重排变化不错误命中，删除后无旧回答 | S07/S09 |
| A15 | 第二写者与坏盘 | 第二实例拒绝；磁盘错误/损坏/未知 schema 不报成功或清空库 | S02/S11 |
| A16 | 冷安装与浏览器闭环 | lockfile 安装、构建、真实 UI/API、模型配置和持久化全链路 | S10/S11/S12 |
| A17 | 核心图谱算法保真 | G01–G12 有 TS 实现及参考执行证据，默认 VECTOR、WEIGHT 配额、排序、融合、权重与来源均对照；不以图谱界面替代算法 | S06/S07/S08/S09/S11 |

## 17. 推进和变更规则

- 当前 S01–S11 已完成本地范围，下一步是 S12；G01–G12 以共同夹具和明确适配通过，不以页面闭环替代算法参考，也不宣称真实模型结果或整个 Python 服务等价。
- 阶段出现问题先区分实现缺陷、环境缺失和可选外部条件；不得弱化断言、硬编码回答或删除故障用例换取通过。
- 若 Node 库无法满足本地格式契约，先做最小能力验证，更新受支持矩阵和替代本地实现；不能悄悄改用远程解析或 Python 包。
- 若新增功能进入首版范围，先同步修改两份文档、依赖和验收清单，再安排实现；没有估算依据不承诺固定完工日期。
- 完成阶段的记录必须包含改了什么、为什么、跑了哪些测试和剩余限制；“文件已生成”“服务有 PID”“模型返回任意字符串”均不足以作为功能完成证据。
