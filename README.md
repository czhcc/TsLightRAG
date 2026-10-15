# TsLightRAG

TsLightRAG 是基于 [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) 设计的 TypeScript 文档知识库项目，面向本地文档解析、知识图谱索引和带来源引用的检索增强问答。

项目计划保留 LightRAG 的核心图谱增强检索算法，使用本地文件持久化的内存存储，并通过 Web 界面配置文本、向量和重排模型。

> **当前状态：S02 本地存储基座已完成。** 服务启动会初始化或校验文件持久化的内存 KV、向量、图与状态存储。模型保存与调用、文档处理和图谱检索尚未实现；当前页面仍是只读入口，不代表完整知识库已可使用。

## 快速开始

使用 Node.js **24.19.0** 与 npm **11.9.0**（版本约束见 `.node-version` 和 `package.json`），在仓库根目录执行：

S02 当前支持 Linux 本地文件系统。安装内核文件锁绑定 `fs-ext` 需要 C++ 编译器、make、Python 3 和匹配的 Node headers；Python 只用于安装时编译，不参与应用运行、文档解析或模型调用。

```bash
npm ci
npm run build
npm start
```

生产入口使用 loopback 端口 `9621`，同时提供静态 WebUI 和 `/api/v1` API。模型设置路径为 `/settings/models`。启动不要求模型 key 或业务环境变量；当前页面会显示“服务已启动，知识库尚未就绪”。

启动参数示例：

```bash
npm start -- --host 127.0.0.1 --port 9621 --data-dir ./data
npm start -- --config ./startup.json
```

可选 `startup.json` 只接受 `host`、`port`、`dataDir`，例如 `{"port":9621,"dataDir":"./data"}`。优先级为 CLI > 启动配置文件 > 默认值；相对路径按仓库根目录解析。`--config` 是启动配置，不是尚未实现的模型配置文件。S02 会在 dataDir 初始化空快照或校验并恢复已有数据，不会自动清空已有库。服务仅允许 loopback 监听，`--port 0` 可让系统分配空闲端口。

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
```

`npm test` 先构建再执行单元、契约、HTTP 集成和界面测试。E2E 使用真实服务和 Chromium；优先使用 `/usr/bin/chromium`，否则先执行 `npx playwright install chromium` 安装匹配版本。基础测试无需真实模型密钥。

S02 验证结果：**121 项测试和 1 项浏览器 E2E 通过**，无失败或跳过；包含 10 个真实 SIGKILL 提交边界、单写者与恢复测试。详见 [实施状态](docs/IMPLEMENTATION_STATUS.md) 和 [S02 验证记录](docs/S02_VALIDATION.md)。[S01 记录](docs/S01_VALIDATION.md) 保留当时的 71 项测试与接口状态。

## 本地存储与恢复

已实现内存 KV、归一化 Float32 向量的 cosine/top-k、无向图及状态/贡献表容器。它们是存储基础，不包含实体抽取、模型 embedding 或 GraphRAG 多模式检索。

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

这些算法目前**尚未移植**。实现方案中定义了 G01–G12 保真清单，要求以固定上游版本的参考算法核对中间结果；有图谱界面或模式选项不代表算法移植完成。项目不将 Microsoft GraphRAG 的社区检测、社区报告或全局 map-reduce 作为本次迁移内容。

## 技术路线

| 层次 | 计划选型 |
|---|---|
| 运行时与语言 | Node.js 24 LTS、TypeScript strict、ESM |
| 服务端 | Fastify、运行时 schema 校验、本地解析 Worker |
| WebUI | React、Vite、Graphology/Sigma |
| 存储 | 内存 Map、Float32 向量、邻接图，本地版本化文件快照 |
| 模型接口 | OpenAI-compatible 文本/embedding，标准 Cohere/Jina-compatible rerank |
| 测试 | Vitest、Testing Library、Playwright、本地 HTTP 假模型和源码参考对照 |

S01 已锁定 Node/npm、TypeScript、Fastify、React/Vite 和测试工具链，依赖由 `package-lock.json` 固定。图谱库、解析器和模型适配器将在对应阶段引入，当前未安装的规划依赖不视为已实现。

## 文档与实施进度

- [LightRAG代码转移实现方案](docs/LightRAG代码转移实现方案.md)：上游源码映射、功能边界、目标架构、数据一致性、模型配置、算法与测试门槛。
- [LightRAG代码转移实施步骤](docs/LightRAG代码转移实施步骤.md)：S00–S12 阶段依赖、交付物、各阶段测试和验收场景。
- [实施状态](docs/IMPLEMENTATION_STATUS.md)：各阶段实际进度、验证证据和下一步。
- [S01 验证记录](docs/S01_VALIDATION.md)：已执行命令、测试范围、工具版本和限制。
- [S02 验证记录](docs/S02_VALIDATION.md)：快照格式、锁、故障恢复、测试证据和当前限制。
- [上游来源清单](docs/UPSTREAM_PROVENANCE.md)：分析基准和代码来源。

当前已完成源码分析、方案文档、S01 和 S02。下一步是 **S03：本地模型配置与 HTTP 调用**。G01–G12 图谱算法仍待完整实现及参考对照验证，存储完成不代表算法保真验收完成。

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

上游采用 MIT License，版权声明为 `Copyright (c) 2025 LightRAG Team`。后续复用源码、提示词、界面或测试夹具时，必须保留适用的 MIT 许可和版权声明，并记录来源路径及修改。当前 S01/S02 工程与存储代码为新编写，尚未导入上游应用算法代码。
