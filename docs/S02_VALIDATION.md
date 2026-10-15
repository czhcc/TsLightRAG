# S02 本地存储验证记录

日期：2026-10-15（Asia/Shanghai）。范围为 S02：文件持久化的内存 KV、向量、无向图、状态/贡献容器、快照和单写者互斥。模型、解析、文档业务及 GraphRAG 检索算法仍未实现。

## 运行与安装

- Linux x64，Node 24.19.0 / npm 11.9.0；沿用 S01 工具链。
- 新增 `fs-ext@2.1.1`，同一 Node 进程直接持有内核 `flock`；`nan@2.29.0` 和 `@types/fs-ext@2.0.3` 固定在 lockfile。
- 安装 native 扩展需要 Python 3、make、C++ 编译器和匹配 Node headers；应用启动/存储运行不调用 Python 或 flock 子进程。
- 本机 home 不可写，普通安装首次因 node-gyp 缓存目录失败；随后使用工作区 devdir 成功安装，并验证全新 npm ci：

```bash
npm_config_devdir="$PWD/.cache/node-gyp" npm ci --no-audit --no-fund
npm run typecheck
npm run lint
npm run build
npx vitest run --reporter=default --reporter=json --outputFile.json=.tools/s02-vitest.json
npm run test:e2e
```

`npm_config_devdir` 只影响构建缓存，不是模型/业务配置或运行时依赖。npm 11 会提示这个透传的 node-gyp 配置未来大版本可能不支持；当前锁定 npm 11.9.0 的安装和冷安装已验证，不关闭 TLS 或完整性校验。

## 存储格式与提交语义

固定 `default` 工作区，版本号 `schemaVersion=1`。每代写入六个 namespace 文件：`kv.json`、`document-status.json`、三个 `vectors-*.json` 和 `graph.json`，以及 manifest。CURRENT 含 generation 和 manifest SHA-256；manifest 含各文件 SHA-256、前代指针、revision/corpusRevision。

- KV 用内存 Map，JSON 以 `[id,value]` 行保存，避免对象 key 的 prototype 混淆；读写和导出深拷贝。
- 向量以有限 number[] 写 JSON，恢复 Float32Array；校验维度、单位范数、float32 表示和空间。精确 cosine/top-k，阈值过滤，同分按稳定 ID；这不替代后续图来源 VECTOR 的首次顺序规则。
- 图保存规范化无向端点、节点和边，恢复邻接；支持自环，degree 对自环计 2，与 NetworkX Graph 基本度数语义一致。
- 文档状态与文档 metadata 一致；可见块指向 processed 文档对应版本。图来源指向有效块，正反贡献集合及三类向量 ID 必须完整匹配；三类向量的空间与维度一致。
- 每次事务在串行队列内复制最新快照，回调同步修改 candidate，校验并再复制后持久化。回调返回 Promise 被拒绝，不在锁内做长耗时模型调用。
- 六文件及 manifest fsync、代目录和父目录同步，再写临时 CURRENT 并原子 rename/sync。CURRENT 发布前查询只见旧内存；成功后新请求见新代，旧捕获视图仍稳定。
- 自动递增一般 revision；只有可查询内容、图、向量/空间变化才递增 corpusRevision。缓存、任务与时间 metadata 更新不自动失效语料缓存。
- CURRENT 发布后的故障有 `PublishedCommitError`，包含 generation、published=true 和 durabilityConfirmed；存储隔离，不把已发布误报为完全未写。恢复/重启前健康接口 503，不能盲目重放。

每个 namespace 最大 256 MiB（写入/读取均检查）。容量仍受全量内存与快照复制成本约束，不是大规模数据库。

## 单写者与恢复

lease 位于 `locks/writer/lease`，内核锁与打开的文件描述符同进程存活。不能按 PID、锁文字、mtime 或超时抢占；不会删除 lease inode。第二个应用实例或 inspect/recover 进程访问同一根目录时明确失败，不同 dataDir 可独立运行。

SIGTERM 先关闭 HTTP、等待已接受事务完成后释放锁；SIGKILL 由内核释放。崩溃产生的未完成 generation 不会被自动选为当前库。

检查 CURRENT/manifest/file checksum、schema、目录/file symlink 和交叉引用；缺 CURRENT 但已有文件时拒绝新建空库。损坏路径不会被自动清空或回滚。维护命令使用同一排他锁，须先停止使用该目录的服务：

```bash
npm run storage:inspect -- --data-dir ./data
npm run storage:inspect -- --data-dir ./data --generation <generation-id>
npm run storage:recover -- --data-dir ./data --generation <generation-id> --confirm-data-loss
```

显式恢复验证选中 generation 的完整性及引用，备份旧 CURRENT，再发布指定指针。它可能回退已确认变更，必须人工选代并给确认参数；不能使用它当自动容错或业务重试。inspect/recover 可能创建必要目录和更新锁诊断信息，但不自动初始化空 generation。

当前保留全部已提交及失败候选代，没有自动 GC 或在线 compact。初次初始化在 CURRENT 发布前中断、且没有任何完整代时，需要离线保全文件后明确处理，不自动删除目录冒充恢复成功。备份至少覆盖停止写入后的整个数据目录，单独拷贝 CURRENT 不构成备份。

## 实际测试结果

**最终 13 个文件、121 项测试全部通过，0 失败，0 跳过；1 项 Chromium E2E 通过。** 119 项初轮已通过，之后补充存储隔离时健康返回 503 与拒绝在未识别旧数据目录初始化空库的用例，冷安装及最终审查后为 121 项。

| 测试文件 | 项数 | 核查行为 |
|---|---:|---|
| kv.test.ts | 3 | Unicode、深拷贝、JSON/key 校验、重复 ID/prototype key |
| vectors.test.ts | 7 | 手算 cosine、排序/阈值、维度/非有限/零向量、空间、20 次 float32 JSON 往返 |
| graph.test.ts | 3 | 无向键、邻接/度数、自环、删除、恢复和无悬空边 |
| snapshot.integration.test.ts | 21 | 全量重开、稳定视图、并发增量、元数据 revision、旧 revision 冲突、边界 EIO 注入、真实文件写冲突、发布后隔离、坏文件/空间/引用及显式恢复 |
| snapshot-crash.integration.test.ts | 10 | 六个 namespace、manifest、CURRENT 前、rename 后、目录同步后的真实子进程 SIGKILL |
| writer-lock.integration.test.ts | 3 | 第二实例拒绝、不同目录独立、伪造/过期 owner 不抢活锁、SIGKILL 解锁、symlink 拒绝 |
| storage-lifecycle.integration.test.ts | 3 | 真实服务器恢复数据、第二服务拒绝、退出/再启动、维护 CLI、损坏启动拒绝、隔离后健康 503 |
| 其余 S01 契约/CLI/HTTP/UI/工具测试 | 71 | 原断言保留；将阶段和实际存储初始化状态更新为 S02 |

SIGKILL 测试用已索引的合成文档、图、状态及三类向量；候选同时修改 metadata、KV、图与向量。各边界重启后断言整组都为旧或新，不只是判断文件存在。CURRENT 尚未发布时必须全旧，已 rename 后重启观察全新。

故障测试还包括：重算 checksum 后的逻辑损坏仍拒绝、CURRENT 损坏保留原字节、未知 schema/缺文件/CURRENT、源路径 symlink、未识别旧数据目录拒绝空库初始化、实际 O_EXCL 文件冲突（EEXIST，root 运行也有效）、发布后的持久化确认状态和后续写入隔离。模拟 EIO 与真实 I/O 失败分开记录，不声称实际拔盘测试。

浏览器实际访问构建 UI/API，验证模型设置导航/刷新和“存储已初始化”；不发模型或第三方请求，不伪造知识库可用。生产启动脚本已更新为 S02 并经真实健康、模型设置、静态页面检查。native 依赖 npm ci、类型、lint、构建和 121 测试均冷安装后通过。npm audit 当次为 0 已报告漏洞。

## 发现与修正

- native 首次安装尝试写不可写 home 缓存；改工作区 devdir 后安装和 npm ci 均通过。
- lint 要求保留捕获异常的 cause；文件锁错误分支已修正，不吞掉底层锁不支持等错误。
- 审查时将真实权限错误夹具改为实际文件冲突，以便 root/普通用户均可靠触发写失败，未放宽“不能报成功”的断言。
- 加强语料版本计算：元数据时钟更新不递增 corpusRevision；新增断言确认进度/缓存提交不使语料版本漂移。
- S01 历史 health 断言和 UI 提示按实际 S02 初始化状态更新，其他契约/错误/HTTP/取消断言保留。

## 尚未验证及下一步

没有实体/关系抽取、embedding 生成、文档解析/任务管线、五模式检索、重排/回答和共享实体业务删除。G01–G12 仍不能标为已完成；这里的贡献校验与图存储只是其基础。

没有验证 NFS/共享卷、多机多进程共享写入、Windows/macOS、真正物理掉电或硬盘永久失效、生产负载。单写者 Linux 本地文件系统是当前适用范围。格式为目标端自有 JSON，不读取 Python LightRAG 内部存储文件。

下一步是 S03：界面模型配置、受限本地保存、HTTP 协议、角色绑定和连接测试。S01/S02 均本地提交，未因本轮任务推送远端；安装与启动配置更新为草稿，不代表已发布或验证新任务恢复。
