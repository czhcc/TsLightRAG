# 上游来源清单

## 分析基准

- 项目：<https://github.com/HKUDS/LightRAG>。
- 固定提交：`aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。
- 许可：MIT；版权声明：`Copyright (c) 2025 LightRAG Team`。
- 分析范围与符号映射：[实现方案 §3](LightRAG代码转移实现方案.md)、[核心图谱算法 §8.4](LightRAG代码转移实现方案.md)。

## S01 来源状态

本阶段新增的 TypeScript 工程、共享契约、Fastify 服务、启动参数解析、React 页面、测试及辅助工具均为本仓库新编写代码。契约的领域名称、五种检索模式、VECTOR/5 默认值依据固定版本的 `base.py`、`constants.py` 和前述设计；没有复制上游 Python 实现、React 组件、提示词正文或测试夹具。

| 目标内容 | 来源关系 | 当前限制 |
|---|---|---|
| `internal/contracts/src/index.ts` | 依据领域设计新建类型与 Zod 校验；模式和图块选择默认值参考上游 | schema 不等于算法实现；不承诺全部上游 API 字段兼容 |
| `apps/server/` | 新编写的工程入口、只读状态 API、静态服务 | 无存储、解析、模型调用和 GraphRAG 算法 |
| `apps/web/` | 新编写的 React 工程入口、工作台和模型角色说明 | 不包含上游 UI 组件；没有模型编辑或保存能力 |
| `tests/` 和 `*.test.*` | 新编写的契约、启动、协议夹具基础和 UI/HTTP 测试 | 尚未生成 G01–G12 的源码参考结果，不能宣称算法保真验收通过 |

后续实际迁入代码、模板或夹具时，应逐文件补充上游路径、SHA、目标路径、修改说明和适用许可，并保留原版权与许可。新增第三方依赖以 `package-lock.json` 定位，按其实际许可要求处理；不把曾用于其他工程的 Apache 许可套用到 LightRAG。

## S02 来源状态

`apps/server/src/storage/` 及新增存储测试均为新编写代码，依据方案的默认文件存储功能和单写者/故障恢复原则实现；未翻译 NetworkX/nano-vectordb 的 Python 源码，也未引入上游业务算法。

`fs-ext@2.1.1` 是运行时原生文件锁绑定，锁属于当前 Node 进程，不是外部数据库或 daemon；其安装包提供 `LICENSE.txt` 的 MIT 授权文本（package.json 未声明统一 license 字段）。`nan@2.29.0` 为该原生扩展的 MIT 构建依赖，`@types/fs-ext@2.0.3` 仅开发类型。均通过 npm 及 lockfile 获取，未把第三方源文件或编译产物 vendoring 到本仓库。未来打包分发依赖时仍需保留其许可。

## S03 来源状态

`apps/server/src/models/`、模型 API、`apps/web/src/ModelSettings.tsx` 和新增协议/配置/浏览器测试均为新编写代码，依据本仓库方案及 OpenAI-compatible、标准 Cohere/Jina-compatible HTTP 数据结构实现，没有复制上游 Python 适配器、提示词、UI 或测试结果。网络层使用 Node 内置 HTTP(S)/DNS/TLS，未新增依赖；G01–G12 仍待业务算法和源码参考验收。S01/S02 来源段落描述当时阶段，当前能力以 IMPLEMENTATION_STATUS 为准。

## S04 来源状态

`apps/server/src/parsers/`、`core/tokenizer.ts`/`chunker.ts`、解析契约、能力矩阵和全部文件夹具/生成器/测试均为本仓库新编写；未复制上游 parser/chunker 源码、提示词或样例文件。固定窗口及来源跨度依据方案设计，Unicode 边界行为见 S04 验证记录，不宣称全部上游解析输出相同。图谱业务算法和 G01–G12 参考结果仍未迁入。

| 新依赖 | 固定版本 | 包许可与用途 |
|---|---|---|
| pdfjs-dist | 6.4.299 | Apache-2.0；本地 PDF 文本层，使用安装包内 cmap/font/wasm |
| yauzl | 3.4.0 | MIT；受限 ZIP 读取，不提取到文件系统 |
| saxes | 6.0.0 | ISC；XML 结构与预算 |
| remark-parse / unified | 11.0.0 / 11.0.5 | MIT；本地 Markdown AST |
| parse5 | 8.0.1 | MIT；静态 HTML AST |
| csv-parse | 7.0.3 | MIT；本地 CSV |
| js-tiktoken | 1.0.21 | MIT；固定本地编码及词表 |
| fflate / @types/yauzl | 0.8.3 / 3.4.0 | MIT；开发夹具生成/安全变体与类型 |

依赖经 npm/lockfile 获取，未把其源码、原生预编译模块或字体资产 vendoring 到 Git。PDF.js 包内资产/原生可选依赖可能另有附带声明，实际分发 npm 依赖时须同时保留相关 LICENSE/NOTICE/版权，不能只保留本表。根项目与 LightRAG 的许可交付仍在 S12 完整审查；本表不更改 LightRAG 的 MIT 版权约定。

## S05 来源状态

`apps/server/src/documents/`、Worker 阶段通知、文档/任务契约与存储校验、`apps/web/src/Documents.tsx` 以及新导入/任务/取消/重启测试均为新编写，依据本仓库方案实现。未复制上游 pipeline/router/UI/提示词或夹具，无新增第三方依赖。`awaiting_indexing` 是目标端为明确 S05/S06 边界增加的状态，不宣称全部上游任务/API 兼容；GraphRAG 算法及参考验收仍待后续阶段。
