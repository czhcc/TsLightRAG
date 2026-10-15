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
