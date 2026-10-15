# 实施状态

更新日期：2026-10-15（Asia/Shanghai）。上游固定基准：`HKUDS/LightRAG@aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。

## 当前阶段

| 阶段 | 状态 | 已完成或待办 |
|---|---|---|
| S00 | 已完成分析和初始来源记录 | 两份方案、F01–F13 范围、G01–G12 算法门槛；后续复用文件继续补来源 |
| S01 | 已完成 | npm workspaces、TS strict/ESM、运行时 schema、CLI、HTTP 与 WebUI 基座、测试辅助工具；71 测试 + 1 Chromium E2E 通过 |
| S02 | 已完成 | 内存 KV/向量/无向图、状态和贡献容器、原生 flock、校验快照与离线恢复；121 测试 + 1 Chromium E2E 通过 |
| S03 | 未开始 | 模型 profile 编辑/持久化、独立地址与 key、角色绑定、HTTP 适配和连接测试 |
| S04 | 未开始 | 全本地文档解析、Worker、tokenizer 和分块 |
| S05 | 未开始 | 文件上传、持久化任务、状态机、重试和取消 |
| S06 | 未开始 | 实体关系抽取、合并、贡献账本和三类索引 |
| S07 | 未开始 | 删除、重建与 embedding 空间切换 |
| S08 | 未开始 | 五模式检索、VECTOR/WEIGHT、重排、上下文与引用 |
| S09 | 未开始 | 生成、NDJSON 流、取消和缓存 |
| S10 | 未开始 | 完整模型/文档/查询/图谱界面联调 |
| S11 | 未开始 | 业务闭环、故障恢复、全部离线/E2E 与算法参考验收 |
| S12 | 未开始 | 完整使用文档、许可和交付审查 |

## S02 当前能力与验证

- 同进程内核 `flock` 排他锁，拒绝第二个 writer；不依赖 PID、文件年龄或租约超时，SIGKILL 后内核释放。Linux 本地文件系统范围内验证。
- 内存 KV 读写隔离、有限 Float32 向量/cosine/top-k、三类向量命名空间、无向图和邻接/度数；序列化为 JSON，再严格恢复类型。
- 固定 default 工作区，文档/块、任务、图来源、正反贡献、三类向量和 embedding 空间的交叉完整性校验；不发布不一致候选。
- 同一串行提交入口从最新代应用增量；写完整 namespace/manifest 并同步后原子替换 CURRENT。读取持有稳定已提交视图，逃逸 draft/返回值不能修改已发布内存。
- 自动区分 generation/revision 与 corpusRevision：缓存和任务元数据提交不无意义地改变语料版本；图/向量/已索引内容变化自动递增。
- 发布前失败保留旧代；CURRENT 发布后错误抛出 published 标记和持久化是否确认，隔离后续读写，健康 API 返回 503，禁止盲目重放。
- 损坏 checksum、未知 schema、缺文件/CURRENT、混合空间、悬空引用和 symlink 拒绝加载，不覆盖为空；离线 inspect/recover 共享 writer 锁，显式确认恢复并备份 CURRENT。
- 实际服务器在监听前初始化/恢复存储，SIGTERM 时释放；健康与 UI 已改为 S02/存储就绪，但 usable=false、模型仍未配置。
- 最终 **13 文件 / 121 测试通过，0 失败/跳过；1 Chromium E2E 通过**。包含 10 个真实 SIGKILL 提交边界、锁文件伪造/过期仍不抢活锁、实际文件 I/O 错误和服务重启。
- native 依赖冷安装、typecheck/lint/build、完整回归已通过；安装时将 node-gyp 缓存放工作区。它是构建缓存设置，不是业务或模型环境变量。

当前证据见 [S02 验证记录](S02_VALIDATION.md) 与 [s02-validation.json](reference/s02-validation.json)。保留所有历史和候选快照便于诊断，未实现自动 GC；不承诺 NFS、多机写入、Windows/macOS 或物理掉电测试。

## S01 历史验证

以下保留 S01 提交时的能力与结果；其 health 字段和 dataDir 行为已由 S02 上述实现更新，不作为当前未初始化的断言。

- Node 24.19.0 / npm 11.9.0，TypeScript 6.0.3，private workspaces 和 lockfile；类型检查、lint、build 及 npm ci 后重复验证通过。
- 共享 Zod schema 覆盖模型及绑定、文档/任务、实体/关系、查询、引用、API 错误及 NDJSON 事件；这是契约，不是领域算法。
- CLI 仅从默认值、可选启动 JSON 和参数读取 host/port/dataDir，不读业务环境变量。仅 loopback；支持动态端口；路径相对仓库根目录；启动配置无隐式模型 key。
- `GET /api/v1/health` 明确 `status=ok`、`usable=false`、模型未配置、存储未实现；只读模型配置返回空列表且 `editingAvailable=false`。
- 生产服务提供构建后的静态页面和模型设置路径；未知 API/资源返回 JSON 404，同源/Host 校验、安全响应头及 body 限制。
- React 实际请求状态和模型 API，有加载、错误/重试、请求取消和设置导航；不伪造保存、导入、索引或问答能力。
- 测试辅助工具提供独立临时目录、空继承环境的真实子进程、动态端口、可判别响应的本地 HTTP 假模型和清理；不把夹具当作已经实现的模型适配器。
- `npm run dev` 启动真实服务和 Vite，9621/5174 同源代理和 TSX 转换经 HTTP 与 Chromium 验证。既有 5173 服务未停止或修改。
- 可复用环境安装与启动脚本已保存到配置草稿，实际启动脚本验证通过；未发布配置，未验证新任务恢复。

实际命令、初次失败与修正、版本和结果见 [S01_VALIDATION](S01_VALIDATION.md)；机器可读证据见 [s01-validation.json](reference/s01-validation.json)。运行日志、截图、缓存与构建产物均被忽略，不含用户模型密钥。

## 边界与下一步

当前可运行真实本地存储和只读基座页面。不能保存模型、上传文档、生成 embedding、抽取图谱或问答。文档/图谱业务生命周期、共享实体删除重建和 G01–G12 保真验收仍未实现；基础存储通过不代表 LightRAG 算法移植完成。

下一步按计划执行 **S03**：本地模型 profile 编辑与保存、独立文本/向量/重排地址、角色绑定和 HTTP 适配/连接测试。保持 CLI/本地配置无业务环境变量、仅本地存储/解析、不发布 SDK 的约定。
