# TsLightRAG

TsLightRAG 是基于 [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) 设计的 TypeScript 文档知识库项目，面向本地文档解析、知识图谱索引和带来源引用的检索增强问答。

项目计划保留 LightRAG 的核心图谱增强检索算法，使用本地文件持久化的内存存储，并通过 Web 界面配置文本、向量和重排模型。

> **当前状态：S01–S11 已完成本地范围，S12 交付审查待执行。** 支持本地存储、模型配置、九格式文档导入与解析、分块、持久化任务、取消/重试和重启恢复。已接入实体关系抽取、共享贡献合并、三类索引、删除/重新索引及向量空间切换；五模式检索、重排、带引用回答、NDJSON 流式生成、停止与受限缓存均已接入。S10 已补图谱浏览、来源追溯、文档拖放/过滤和安全 Markdown。

## 快速开始

使用 Node.js **24.19.0** 与 npm **11.9.0**（版本约束见 `.node-version` 和 `package.json`），在仓库根目录执行：

当前支持 Linux 本地文件系统。安装内核文件锁绑定 `fs-ext` 需要 C++ 编译器、make、Python 3 和匹配的 Node headers；Python 用于安装时编译及可选源码参考验证，不参与应用运行、文档解析或模型调用。

```bash
npm ci
npm run build
npm start
```

生产入口使用 loopback 端口 `9621`，同时提供静态 WebUI 和 `/api/v1` API。模型设置路径为 `/settings/models`。启动不要求模型 key 或业务环境变量；首次未配置模型时页面显示“服务已启动，知识库尚未就绪”；配置齐备后可导入文档并检索问答。

启动参数示例：

```bash
npm start -- --host 127.0.0.1 --port 9621 --data-dir ./data
npm start -- --config ./startup.json
```

可选 `startup.json` 只接受 `host`、`port`、`dataDir`，例如 `{"port":9621,"dataDir":"./data"}`。优先级为 CLI > 启动配置文件 > 默认值；相对路径按仓库根目录解析。`--config` 是启动配置；模型配置通过界面保存在 `<dataDir>/config/app.json`。S02 会在 dataDir 初始化空快照或校验并恢复已有数据，不会自动清空已有库。服务仅允许 loopback 监听，`--port 0` 可让系统分配空闲端口。

开发模式：

```bash
npm run dev
```

开发命令先构建共享契约，再启动服务端文件监听及 Vite。服务端端口为 `9621`，Vite 端口为 `5174`，通过同源代理访问后端。端口被占用时明确失败；停止命令会关闭其子进程。npm 缓存在仓库的 `.cache/npm`，无需向用户 home 写入缓存。

## 测试与检查

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:protocol
npm run test:coverage
# 独立算法参考需先按 scripts/reference/README.md 准备固定源码和验证依赖：
npm run test:reference
```

`npm test` 先构建再执行单元、契约、HTTP 集成和界面测试。E2E 使用真实服务和 Chromium；优先使用 `/usr/bin/chromium`，否则先执行 `npx playwright install chromium` 安装匹配版本。基础测试无需真实模型密钥。

S11 验证结果：**472 项测试和 10 项浏览器 E2E 通过**，无失败或跳过；包含九格式真实夹具、本地解析/禁网/安全/分块、模型协议，以及 10 个快照和 2 个配置真实 SIGKILL 边界。详见 [实施状态](docs/IMPLEMENTATION_STATUS.md) 和 [完整验收报告](docs/VALIDATION_REPORT.md)。核心覆盖率行 98.17%、分支 83.51%；G01–G12 最低共同夹具按明确适配对照通过。[S01 记录](docs/S01_VALIDATION.md) 保留当时的 71 项测试与接口状态。

## 配置模型

打开模型设置，分别添加文本、向量及可选重排 profile，填写地址和模型名称，并选择 query/extract/keyword/embedding/rerank 角色。extract/keyword 默认复用 query。

文本与向量填写 base URL（例如 `https://provider.example/v1`），服务端追加 `/chat/completions` 或 `/embeddings`；重排填写完整 endpoint。向量须填写实际维度；同名模型更换权重时增加 operatorRevision。非空索引继续使用自己的活动模型版本；保存候选后，到文档页“索引维护”重建三类向量并切换。

“测试连接”使用未保存的候选设置发送示例文本，可能计费，不修改索引或保存配置。“保存配置”只保存；版本冲突时重新加载再编辑。密钥留空表示保留，勾选清除表示删除；修改地址后须重新输入或清除旧密钥。保存后密码框清空，GET 只返回 hasApiKey，浏览器不持久保存密钥。

配置在本机以权限受限明文保存（目录 0700、文件 0600），不是加密保险库；不要提交 data/。活动快照及在途任务所需的旧凭据版本保留在 `config/versions/`，清除候选密钥不会清除这些版本；配置历史目前不自动回收。允许显式配置 localhost/LAN 模型，拒绝 metadata/link-local 和自动重定向，保留 HTTPS 证书校验。当前已验证本地协议夹具，未验证外部真实提供商。

## 本地解析与分块

已实现 UTF-8 TXT、Markdown、HTML、CSV、JSON，带文本层 PDF，以及 DOCX、XLSX、PPTX 的本地内容提取。保留标题/行、页码、工作表/行、幻灯片等可用定位；空文档、坏文件、扫描 PDF、加密或不支持格式明确失败，不返回空成功。工作台与 `/api/v1/parsers/capabilities` 展示完整格式矩阵。

默认单文件 20 MiB、ZIP 解压总量 100 MiB、10,000 项、正文 2,000,000 字符，单次排队/解析/分块限时 60 秒。解析在受限 Worker 中执行，不加载外部资源，不执行脚本、公式或宏。V8 堆预算不等于 OS 总内存沙箱。

固定本地 `js-tiktoken@1.0.21`，支持 cl100k_base/o200k_base；默认窗口 1200 tokens、最大重叠 100，保留完整 Unicode 和正文来源映射。所有源码、预算与已知降级见 S04 记录。**可在文档页面上传或粘贴文本，查看解析与索引状态、正文、错误和重试结果。**

## 导入与任务管理

打开 `/documents`，上传文件或粘贴 TXT/Markdown 文本。新导入只有在原文和任务记录持久化后才返回 202；相同内容去重，同名异内容分别保存。页面显示真实阶段、警告/错误、解析预览，并支持取消和手动重试。解析不调用外部模型。配置 query/embedding 后，文本块将发送到所配置的 extract（默认 query）和 embedding 地址，完成图谱与向量索引；缺少配置时停在“待配置模型”，保存配置后需手动重试。

服务退出会中断未完成任务；强制终止后重启也会保留原文和任务，等待手动重试，不自动重新收费处理。原文存于 `data/documents/`，完整解析产物存于 `data/staging/`；备份整个停止写入的数据目录。不要删除未理解的文件、快照或锁来“重置”任务。

最多 2 个活动任务、10 个活动/排队任务；最多 1000 文档、5000 任务记录，原文和已关联产物分别限 256 MiB。历史快照和未引用文件另外占空间，当前没有自动 GC。详细协议、幂等规则和限制见 S05 验证记录。

## 图谱与索引

抽取使用固定版本 LightRAG 的 JSON 提示词，最多 1 次格式修复和 1 轮补充抽取；无效、超限、缺端点或截断结果明确失败。保留块级有效贡献，按实体名称合并、规范化无向关系、去重描述与来源；新来源增加关系强度，权重至少为独立来源数。原始贡献、双向来源锚点、三类向量与 processed 状态在同一完整快照中发布。

抽取缓存包含模型配置版本、提示词、分块器、编码和内容身份；失败不缓存为成功，向量失败后可手动重试复用有效抽取。描述多于阈值时调用文本模型摘要。缓存与历史快照保存在本机，当前没有自动清理；缓存容量上限 128 MiB。配置齐备后的导入会实际调用模型，可能计费。

S07 已完成删除、重新索引、完整向量重建与空间切换；S08/S09 已完成检索、重排、引用和回答。S11 已完成 G01–G12 最低共同夹具对照及明确适配；这不证明真实供应商向量或回答质量相同。详见 [完整验收报告](docs/VALIDATION_REPORT.md)。

## 检索与问答

完成索引后打开 `/query`，输入问题并选择 naive、local、global、hybrid 或默认 mix。可选 VECTOR/WEIGHT 关联块策略、关联块数量与重排。点击“检索证据”预览正文、文档版本/原始位置、上下文、完整提示词与预算；点击“生成回答”逐步读取带引用回答，可随时停止，取消/错误后的部分内容明确标记。

`POST /api/v1/query/data` 接收查询与选项；onlyNeedContext/onlyNeedPrompt 可预览检索上下文或待生成提示词。`POST /api/v1/query` 返回非流式回答，`POST /api/v1/query/stream` 提供 NDJSON。关键词、向量、回答与可选重排会访问配置地址，可能计费。查询固定使用所读索引的活动向量模型；尚未激活的候选不参与搜索旧库。

来源块默认只在图关联集合中做 VECTOR 排序，mix 另外召回全文本向量库。引用仅来自最终预算保留的证据，同名文档分别关联。完整成功回答按语料/模型/空间/历史/预算等隔离缓存；取消、失败、截断和警告结果不写回答缓存。查询缓存有容量/15 分钟 TTL，重启清空，删除/重建使旧回答失效。无证据时不调用回答模型。实现范围、Python 参考与适配差异见 S08/S09 验证记录；不保证与 Python 原版生成相同向量或自然语言结果。

## 图谱浏览与来源

打开 `/graph`，按实体名称或关系描述/关键词/端点名称搜索。每次最多显示 100 个节点、300 条关系；实体和关系列表可查看属性与真实来源，选择实体后可展开一层邻居（替换当前视图）。来源分页显示文档版本、文本块及可用原始位置，可跳转到对应文档。删除文档后刷新图谱查看存活贡献；若语料在查看来源期间变化，页面会要求刷新。

图谱使用 SVG 环形布局，不提供手工编辑、拖拽、缩放或无限全图加载。回答支持安全 Markdown，原始 HTML 和图片不加载，外部链接需用户主动打开。文档页支持单文件拖放及服务端名称/状态过滤。

## 删除、重新索引与向量切换

在文档页选择文档，可沿用原文件重新索引，也可用 TXT/Markdown 正文替换。处理期间旧版本保持可读；新版本成功后才替换贡献并递增文档版本。删除会从存活来源重算共享实体和关系，避免保留已删文档的描述或权重。删除/清空需要在界面明确勾选确认。

保存不同 embedding 模型、维度或 operatorRevision 后，在“索引维护”选择已保存的目标模型，执行“重建三类向量并切换”。新向量完整生成前，现有索引和新导入继续使用旧活动版本；失败或取消保留旧索引。全库重建/清空要求先结束活动任务；版本冲突会明确失败，重新加载后可手动重试，不自动收费重跑。

删除在完整快照提交后才创建文件释放计划。保留快照仍引用原文/解析产物时，计划显示 retained，文件继续保存；可在引用真正退出后重试释放。应用不自动删除历史 generation、配置版本或未知文件，不承诺物理擦除。备份需包含整个停止写入的数据目录。协议、恢复测试与参考算法范围见 [S07 验证记录](docs/S07_VALIDATION.md)。

## 本地存储与恢复

已实现内存 KV、归一化 Float32 向量的 cosine/top-k、无向图及状态/贡献表容器。已用于持久化文档块、实体和关系索引。GraphRAG 五模式检索和回答生成已接入。

数据位于 `data/workspace/default/`，以完整 generation 文件和 `CURRENT` 指针发布。查询持有一个稳定版本；同一 dataDir 只允许一个服务或维护进程持有内核文件锁。锁文件内容和年龄不是判断依据，进程退出后锁由内核释放，不能通过删除 lease 文件解锁。

损坏、未知 schema、缺失文件或无效引用会阻止启动，不自动选择旧代或覆盖成空库。需要恢复时，先停止使用该 dataDir 的服务，再检查并明确选择完整 generation：

```bash
npm run storage:inspect -- --data-dir ./data
# CURRENT 损坏时，可从 data/workspace/default/generations 查找候选 ID 后检查：
npm run storage:inspect -- --data-dir ./data --generation <generation-id>
# 恢复会回退到选中代，可能丢弃之后的变更；须显式确认：
npm run storage:recover -- --data-dir ./data --generation <generation-id> --confirm-data-loss
```

维护命令与应用使用同一个排他锁，运行中的服务会使维护命令失败。恢复前会完整校验目标代，并备份已有 CURRENT。当前保留全部历史及失败候选代便于诊断，没有自动 GC；空间和单命名空间文件 256 MiB 上限见 S02 验证记录。

## 项目目标

- **TypeScript 实现**：服务端、领域逻辑和 WebUI 使用 TypeScript，不以 Python 服务作为业务运行依赖。
- **本地存储**：KV、向量、图和文档状态保存在内存中，并持久化到本地文件，无需 PostgreSQL 或其他外部数据库。
- **本地解析**：文档解析在本机执行，不依赖 MinerU、Docling 等远程解析服务。
- **界面配置模型**：文本、向量、重排模型可分别设置地址、模型名称和可选 API key；抽取、关键词和回答可使用不同文本模型。
- **无需环境变量**：业务配置使用本地配置文件、界面和启动参数，不要求 `.env`。
- **测试随功能交付**：每个实施阶段同时提供测试，覆盖算法、持久化、模型协议、HTTP API 和浏览器交互。

本地解析不代表全部推理离线。使用外部模型时，解析后的文本片段、问题和检索上下文会发送到用户配置的模型接口；原始二进制文件不发送给远程解析服务。

## 计划功能

| 模块 | 范围 |
|---|---|
| 文档管理 | 文件上传、粘贴文本、去重、处理状态、失败重试、删除和重新索引 |
| 文档解析 | TXT、Markdown、HTML、CSV、JSON、带文本层 PDF、DOCX、XLSX、PPTX |
| 索引构建 | token 分块、实体与关系抽取、描述合并与摘要、来源贡献追踪 |
| 本地存储 | 文档与文本块 KV，实体/关系/文本块三类向量索引，无向知识图谱 |
| 检索问答 | `naive`、`local`、`global`、`hybrid`、`mix`，可选重排、上下文预算、流式回答与来源引用 |
| 图谱浏览 | 节点搜索、限量子图、邻居展开、属性和来源查看 |
| 模型配置 | 独立模型地址、角色绑定、连接测试、密钥遮蔽、配置持久化与向量空间重建 |
| 恢复与一致性 | 单写者、原子快照、重启恢复、共享实体删除后的重建和缓存失效 |

首版定位为本地单用户、小型知识库应用。全量内存索引受可用 RAM 和文件快照成本限制，不以大规模集群服务为目标。

## 核心图谱算法

迁移范围是 **LightRAG 自身的图谱增强 RAG 算法**，包括：

- 实体与关系抽取、补充抽取、来源去重、关系权重及描述摘要。
- 低层关键词驱动的实体检索和高层关键词驱动的关系检索。
- `local/global` 双层召回，以及 `hybrid/mix` 候选融合。
- 图关联证据块的 `VECTOR` 和 `WEIGHT` 选择策略，默认使用 `VECTOR`。
- 图候选排序、三路文本块融合、重排、预算截断和引用构建。
- 文档删除后的共享图谱贡献撤销与重建。

以上功能已在 S06–S09 分阶段实现。S08 对固定源码执行检索、来源块、排序/融合、截断与引用参考，并公开索引文本格式、严格 JSON 和预算等适配差异。S11 已补齐 G01–G12 最低共同夹具对照；显式适配及外部未验证项见完整报告，不保证与 Python 真实模型结果一致。项目不将 Microsoft GraphRAG 的社区检测、社区报告或全局 map-reduce 作为本次迁移内容。

## 技术路线

| 层次 | 计划选型 |
|---|---|
| 运行时与语言 | Node.js 24 LTS、TypeScript strict、ESM |
| 服务端 | Fastify、运行时 schema 校验、本地解析 Worker |
| WebUI | React、Vite、有数量上限的 SVG 图谱 |
| 存储 | 内存 Map、Float32 向量、邻接图，本地版本化文件快照 |
| 模型接口 | OpenAI-compatible 文本/embedding，标准 Cohere/Jina-compatible rerank |
| 测试 | Vitest、Testing Library、Playwright、本地 HTTP 假模型和源码参考对照 |

S01 已锁定 Node/npm、TypeScript、Fastify、React/Vite 和测试工具链，依赖由 `package-lock.json` 固定。模型 HTTP 适配器使用 Node 内置 HTTP(S)；PDF.js、受限 OOXML/ZIP/XML、Markdown/HTML/CSV 解析与 js-tiktoken 已锁定；图谱界面库将在对应阶段引入。

## 文档与实施进度

- [LightRAG代码转移实现方案](docs/LightRAG代码转移实现方案.md)：上游源码映射、功能边界、目标架构、数据一致性、模型配置、算法与测试门槛。
- [LightRAG代码转移实施步骤](docs/LightRAG代码转移实施步骤.md)：S00–S12 阶段依赖、交付物、各阶段测试和验收场景。
- [实施状态](docs/IMPLEMENTATION_STATUS.md)：各阶段实际进度、验证证据和下一步。
- [S01 验证记录](docs/S01_VALIDATION.md)：已执行命令、测试范围、工具版本和限制。
- [S02 验证记录](docs/S02_VALIDATION.md)：快照格式、锁、故障恢复、测试证据和当前限制。
- [S03 验证记录](docs/S03_VALIDATION.md)：配置持久化、模型协议、候选连接与浏览器测试。
- [S04 验证记录](docs/S04_VALIDATION.md)：九格式解析矩阵、Worker/禁网/预算、token 分块与真实文件夹具。
- [S05 验证记录](docs/S05_VALIDATION.md)：原文/产物持久化、导入任务、取消/幂等重试和真实进程重启。
- [S06 验证记录](docs/S06_VALIDATION.md)：抽取/补充、合并摘要、贡献账本、三类向量与原子提交。
- [S07 验证记录](docs/S07_VALIDATION.md)：删除/重建、活动模型绑定、版本替换、并发与文件释放。
- [S08 验证记录](docs/S08_VALIDATION.md)：五模式检索、来源选择、重排、预算、引用、Python 参考和浏览器验证。
- [S09 验证记录](docs/S09_VALIDATION.md)：真实生成、NDJSON、停止/断连、缓存身份/失效与 Python 提示传递参考。
- [S10 验证记录](docs/S10_VALIDATION.md)：模型/文档/查询/图谱界面闭环、安全渲染、共享删除与重启验证。
- [S11 完整验收报告](docs/VALIDATION_REPORT.md)：分类测试、覆盖率、G01–G12 参考对照、故障恢复和可复用运行配置。
- [上游来源清单](docs/UPSTREAM_PROVENANCE.md)：分析基准和代码来源。

当前已完成源码分析、方案文档和 S01–S11 的本地范围。下一步是 **S12：最终许可、文档和交付审查**。G01–G12 的共同夹具最低断言已按明确适配通过；真实供应商、非 Linux、云发布和新任务恢复仍未验证。

获取当前仓库：

```bash
git clone https://github.com/czhcc/TsLightRAG.git
cd TsLightRAG
```

## 首版不包含

- 外部数据库、分布式队列、集群或多进程共享写入。
- 远程文档解析、扫描件 OCR、图片/音视频理解及复杂版面精确还原。
- 多租户、账号/RBAC、SSO、多知识库管理及手工图谱编辑。
- SDK 发布、上游全部 HTTP API 兼容、全部模型供应商原生协议。
- 直接导入 Python LightRAG 的内部存储文件；首版从原始文档重新建立索引。

完整格式能力与排除项见实现方案。

## 代码来源与许可

本项目的设计与迁移依据来自 [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG)，分析基准为提交 [`aaebfe1`](https://github.com/HKUDS/LightRAG/tree/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a)。感谢 LightRAG 团队及贡献者。

上游采用 MIT License，版权声明为 `Copyright (c) 2025 LightRAG Team`。S06/S08 已复用上游 JSON 抽取/补充、摘要、关键词与回答上下文提示词，并依据相关合并算法实现 TypeScript 版本；适用版权与 MIT 全文保留在 [third_party/LightRAG/LICENSE](third_party/LightRAG/LICENSE)。逐文件来源、修改及参考验证范围见 [上游来源清单](docs/UPSTREAM_PROVENANCE.md)。根项目的完整许可交付审查仍在 S12。
