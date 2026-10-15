# S05 文档与持久化任务验证

日期：2026-10-15。实现文件/文本导入、原文及解析产物持久化、真实任务状态、列表/详情、取消/手动重试与重启恢复。沿用 S04 依赖与 lockfile，无新依赖、业务环境变量、数据库或模型费用。

## 阶段边界

S05 完成解析/分块任务基础；实体关系抽取、embedding 和完整索引在 S06 实施。不能将本地解析标为 processed：

```text
queued → parsing → chunking → persisting_parse（phase）
                            ├─ awaiting_configuration：缺 query/embedding，或捕获后配置变化
                            └─ awaiting_indexing：解析完成且模型齐备，等待 S06
任意执行阶段 → failed / cancelled / interrupted
```

`persisting_parse` 只是 chunking 状态内的真实写盘阶段。`awaiting_indexing` 是本阶段新增的显式停靠状态，不伪造 extracting/embedding/processed。两个 awaiting 状态停止调度，用户配置模型后手动重试；S05 不自动发模型协议请求。S06/S09 接入后再验收任务中的模型调用和取消，S03 连接测试的取消回归继续通过。

## 持久化与身份

- `POST /documents` 先接收完整受限 multipart 并拒绝多文件/额外字段，再验证显示文件名/格式；JSON 文本入口只允许 TXT/Markdown。
- 显示名不作为磁盘路径。原文 SHA-256 决定文档 ID 和 `documents/<hash>.blob`；新任务使用 UUID。相同 bytes 复用原文、首个显示名、文档及当前任务；同名异内容是不同文档。并发去重通过单一 admission 队列完成。
- 原文以 0600 临时文件写入/fsync，用同目录 hard link 独占发布、清理本次临时文件并同步目录；已有文件必须是普通文件且 hash 匹配，拒绝 symlink/目录冲突。原文发布成功后才在 SnapshotStore 事务中保存 document、fullDocs 和 job，成功后返回 202。重复导入返回 200。
- 元数据含原文件键/大小、latestJobId；任务含 attempt、previousJobId、捕获 configRevision/公开配置身份 hash/tokenizer/缺项、phase、warnings、安全 errorCode/error、cancelRequested 和产物摘要。没有 key、原始配置或私有错误正文。
- `prepareDocument` 在 Worker 中本地解析和分块，通过 Worker 消息报告真实 parsing/chunking，再串行持久化阶段。产物在 `staging/<job-id>/prepared.json`，含解析块/文本、来源、文本块、版本、原文件 hash 和配置 revision。
- 产物也采用不可覆盖的原子文件发布。发布后才提交摘要/hash/计数和 awaiting 状态；产物始终不进入 S02 的可查询 textChunks/图/向量表。文档管理不改变 corpusRevision。
- 文件/产物路径逐层检查目录及末尾 O_NOFOLLOW，验证普通文件、大小/hash、schema、文档/版本、块偏移与任务身份。启动校验所有受管原文及已关联产物；缺失/损坏拒绝启动，不静默丢弃或覆盖。
- 原文先写而元数据失败、取消/崩溃发生在产物发布与引用提交之间时，可留下未引用文件；保留诊断，不自动 GC。备份必须覆盖停止写入后的整个 dataDir，包括 documents/staging/config/workspace。磁盘配额只计已接受/关联的记录，历史快照及遗留文件会额外占空间。
- 发布前快照错误不返回 202；已发布但同步不确定返回 503 + 明确 published-uncertain code，存储隔离、健康 503，检查/重启后核对记录，不能盲目重放。hash 去重可处理响应丢失后的重试。

## API 与界面

以下路径均有 `/api/v1` 前缀，沿用 Host/Origin/Fetch Metadata 检查，错误统一 `{code,message,requestId}`。

| API | 结果 |
|---|---|
| `POST /documents` | 一个 multipart 文件；新记录 202，重复内容 200，返回 document/job/deduplicated |
| `POST /documents/text` | JSON `{name,text}`；支持 TXT/Markdown，空文本/非法名字明确拒绝 |
| `GET /documents?offset=0&limit=20` | 持久化列表/total；limit 1–100，稳定时间/ID 排序 |
| `GET /documents/:id` | document 和当前 job |
| `GET /documents/:id/parsed` | 已提交解析预览（20,000 字符、100 块），明确截断标记；完整产物保留本机 |
| `GET /jobs/:id` | 当前实际持久化阶段、版本、警告/错误/结果 |
| `POST /jobs/:id/cancel` | 排队/活动/停靠任务取消，重复调用幂等；已 processed/failed/cancelled/interrupted 保留终态 |
| `POST /documents/:id/retry` | 必须 `{expectedJobId}`；可重试终态创建下一 attempt；重复旧请求返回同一次后继，过旧请求 409 |

`/documents` 页面支持文件和文本导入、分页、实际任务状态轮询、详情/警告/错误、解析预览、取消和重试；页面刷新/服务重启后从 API 恢复。不保存文档进度到浏览器存储，不用计时器虚构百分比。不提供删除/重建按钮（S07）。

## 调度、退出与限制

- 最多 2 个活动任务，活动+queued 最多 10；接收完整 multipart 的通道最多 2。队满 429，拒绝记录前检查。S04 Worker 的独立队列/超时/堆预算继续生效。
- 单文件 20 MiB；文本 JSON 最多 2,000,000 字符，路由 body 上限 8 MiB；普通 API body 仍为 1 MiB。最多 1000 文档、5000 历史任务，已接受原文/已关联解析产物分别最多 256 MiB，单产物 32 MiB。产物配额和发布串行处理，避免并发超额。
- 长 CPU 工作在 Worker，长模型请求尚未启用；不持 SnapshotStore 写入队列调用 Worker/模型。配置在 attempt 创建时捕获编码与 revision；解析过程中保存新配置会明确停在 awaiting_configuration，不混用新旧版本。
- 取消先在快照记录标志，再取消活动 Worker。发布事务在同一写入门内重新读取取消/关闭状态，取消获胜时不关联产物、不报 processed；已有 processed 索引保留贡献及终态。取消请求与结果按已持久化事实反馈。
- SIGTERM/SIGINT 停止接收、取消活动任务、等待阶段/元数据写盘，queued/未完成任务持久化 interrupted。HTTP 连接有限超时，退出关闭已有连接，防止未完成上传拖住关机。
- SIGKILL 后下次监听前把残留 queued/执行态改为 interrupted（已有取消标志则 cancelled）。failed/awaiting/已完成 attempt 保持，不自动重跑或收费；只有明确 retry 创建新任务。
- 若终态记录自身写盘失败，任务服务隔离并使健康不可用，不把无法持久确认的进度当成功。服务退出失败输出安全诊断，避免原异常泄露文档内容。

## 实际测试

执行通过：

```bash
npm run typecheck
npm run lint
npm test -- --reporter=json --outputFile=.tools/s05-vitest.json
npx playwright test --reporter=json > .tools/s05-playwright.json
```

最终 **29 文件 / 288 测试通过，0 失败/跳过；5 Chromium E2E 通过，0 失败/跳过/重试**。保留此前 263 项（health stage/jobs 能力和文档接口断言按实际 S05 更新），新增 25 项：

| 文件 | 项数 | 验证 |
|---|---:|---|
| documents-api.integration.test.ts | 7 | 202 前原文持久化/权限、真实 multipart/中文名、并发去重/同名异内容/分页、非法名字/CSRF、20 MiB/字段限额、symlink/实际 I/O 错误、九格式真实上传→Worker→产物 |
| jobs.integration.test.ts | 3 | 可诊断解析失败、重复 retry/attempt 链、配置齐备停在 S06/零模型请求、取消幂等和重试 |
| cancellation.integration.test.ts | 5 | parsing/chunking/产物提交前真实阶段取消、排队取消与背压、解析期间配置版本变化 |
| jobs-restart.integration.test.ts | 6 | 202 后 SIGKILL/SIGTERM、queued 202 立即强杀、手动恢复、failed/parked 不自动重跑、原文/产物损坏拒绝启动 |
| ingestion-commit.integration.test.ts | 4 | 原文已落盘而快照发布前/后故障、不返回虚假 202/安全 503、已完成索引取消竞争、staging symlink/真实产物写失败 |

取消边界测试运行真实应用子进程及 Worker；只在测试 fixture 内的进程参数选择暂停点，无生产调试端点或业务环境开关。已完成索引竞争用 S02 的完整图/向量合成快照，未伪装成 S06 抽取能力。以前的模型取消、263 项协议/解析/存储和 12 个 SIGKILL 边界继续回归。

浏览器新增：文本导入→真实待配置状态/解析预览→重复内容→取消→第二 attempt→真实 DOCX 上传→服务重启后列表、attempt 和预览保留。原 4 项模型/解析能力页面测试保留。

首轮 281 项有 2 项失败：非法文件名/格式被 Fastify 默认处理成 500。发现错误处理器需在路由之前注册，现已统一安全错误结构，并保留 400/去密/请求 ID 断言。首次 lint 的捕获异常 cause 已修正，未放宽检查。随后补充发布失败、九格式、queued 崩溃和产物完整性测试，完整回归通过。未改依赖，沿用 S04 冷安装证据，不声称本阶段额外冷安装。

报告、截图、临时数据在忽略目录；命令、逐项结果与源码/构建指纹见 [s05-validation.json](reference/s05-validation.json)。本机服务更新为 S05；云启动说明保存为草稿不等于发布或新任务恢复验证。

## 下一步

S06 接入块级实体/关系抽取、合并/摘要、贡献账本和三类向量索引；只有完整索引事务发布后才能 processed。S07 删除/重建、S08–S09 检索/生成及 G01–G12 算法参考验收仍未完成。S05 独立本地提交，未自动推送。
