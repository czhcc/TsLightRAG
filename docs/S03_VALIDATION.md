# S03 模型配置与 HTTP 协议验证

日期：2026-10-15。S03 实现本地模型配置、候选连接测试和三类 HTTP 适配器；不包含文档解析、索引或 GraphRAG 检索。沿用 Node 24.19.0 / npm 11.9.0、Linux 本地文件系统，未新增依赖或修改 lockfile。

## 配置与界面

- 启动参数仍为 CLI > 可选启动 JSON > 默认值。`--config` 只接收 host/port/dataDir；模型配置是 `<dataDir>/config/app.json`，从默认空配置启动，经界面/API 保存，不读取业务 `process.env` 或 dotenv。
- 文本 profile 可独立绑定 query/extract/keyword；extract/keyword 为 null 时复用 query。embedding 独立配置；rerank 可不绑定或禁用，支持 Cohere/Jina-compatible 协议和明确失败策略。
- profile 包括独立地址、模型、超时、并发、重试及退避上限；文本包括温度、输出/上下文 token 上限和 tokenizer 策略，向量包括声明维度、批大小、operatorRevision，重排包括 topN 和失败策略。tokenizer 实际分块在 S04 实现。
- GET/保存响应只有 `hasApiKey`，不返回 key。写入时省略保留、null 清除、字符串替换，拒绝星号占位和换行凭据。保留密钥时修改目标地址返回 `KEY_TARGET_CHANGED`，须显式重新输入或清除。
- 配置文件 `schemaVersion=1`、revision 单调递增；保存要求 expectedRevision，串行校验后写临时文件、fsync、rename、目录 fsync，成功后返回新版本。目录 0700、文件 0600，受限明文存储，未声称加密。
- 发布前失败保留旧版本；rename 后无法确认同步时返回 `CONFIG_PUBLISHED_UNCERTAIN` 并隔离配置/健康接口，要求检查和重启，不把已发布误报成未写。崩溃遗留的临时配置不自动激活，仍属本地敏感文件，应随整个 dataDir 保护。
- 设置页支持增删 profile、角色绑定、候选测试、保存、密钥清除、请求取消和冲突后重新加载；保存后清空密码输入框，不使用 localStorage。浏览器只请求同源应用 API，由服务端访问模型。

## API 与身份

| 路径 | 行为 |
|---|---|
| `GET /api/v1/settings/models` | 遮蔽配置、revision、选中 embeddingSpaceId、editingAvailable=true |
| `PUT /api/v1/settings/models` | `{expectedRevision, profiles, bindings}` 保存完整配置，不暗中发模型请求 |
| `POST /api/v1/settings/models/test` | `{expectedRevision, profile}`；使用未保存候选配置和显式示例，可能计费，不保存、不修改索引 |
| `GET /api/v1/health` | stage=S03，动态模型缺项；文档/检索尚未实现，因此 usable=false、jobs.available=false |

`embeddingSpaceId = SHA-256(protocol, canonicalEndpoint, model, dimensions, l2, operatorRevision)`，不包含 key。尾斜杠不改变身份；同维不同模型、地址或 operatorRevision 产生不同身份。配置捕获返回独立副本，调用使用其捕获版本。

当前 embeddingSpaceId 标识**所选配置**；保存和连接测试不修改快照或伪造已建立向量索引。S06 使用它建立索引，S07 实现非空库切换/重建和活动配置引用管理。目前非空索引禁止改变空间、修改/删除 profile 和凭据，返回 `REBUILD_REQUIRED`，防止直接用新模型搜索旧向量；完整非空库激活不计入 S03 已完成能力。

## 协议与网络

- 文本/向量 base URL 保留代理路径，仅追加 `/chat/completions` 或 `/embeddings`；`/v1` 不重复追加。rerank 使用完整 endpoint，原样保留路径及末尾斜杠。
- 文本发送 model/messages/temperature/max_tokens，支持 JSON、SSE delta/[DONE]/usage 和请求流式时的 JSON 回退。处理半包 UTF-8、CRLF、多行 data、空 delta 与 usage-only 帧；拒绝空回答、工具调用、异常终态或不完整流。部分 delta 已交付后不自动重放。
- embedding 分批请求，按 index 恢复原输入顺序，拒绝重复/缺失/越界、错误维度、零向量和非有限值。协议层返回有限原始向量；索引归一化仍由 S02 向量存储负责。
- rerank 使用 `{model,query,documents,top_n}`，校验结果 index 唯一/范围及有限 score，返回真实索引排序。禁用不联网；启用但未绑定报缺配置。失败仅按显式策略返回错误或保留原顺序并附警告，取消不降级为成功。
- 只允许 HTTP(S)，禁止 userinfo/query/fragment；允许用户明确配置 loopback/LAN。阻止 metadata/link-local、未指定地址及组播等目标，DNS 每次连接解析、校验全部答案并固定本次连接地址；HTTPS 保留原主机及标准证书校验。禁止所有自动重定向，不转发密钥到 Location。
- 请求体上限 4 MiB、响应上限 8 MiB（Content-Length 和分块读取均限制），配置/API body 上限 1 MiB。配置 URL 最长 2048 字符。
- 每 profile 限并发、等待队列最多 64；全局最多 16 个在途请求、64 个排队。总超时覆盖排队、DNS、重试和读流；接收 AbortSignal，客户端断开取消上游。
- 网络错误、429、500/502/503/504 有限退避，遵守有上限的 Retry-After；401/403/其他 HTTP 错误、schema 和维度错误不重试。key、上游错误正文和输入文本不进入普通日志/错误响应。
- 延续 loopback Host、同源 Origin 检查，并拒绝 cross-site Fetch Metadata；写接口要求 JSON，不接受简单跨站表单。未引入公网监听或账号系统。

## 验证

执行并通过：

```bash
npm run typecheck
npm run lint
npm test -- --reporter=json --outputFile=.tools/s03-vitest.json
npm run test:e2e -- --reporter=json
npx playwright test --reporter=json > .tools/s03-playwright.json
```

构建/测试按顺序执行，不能让另一个 `npm run build` 清理正在使用的 dist。

最终 **20 文件 / 197 项测试通过，0 失败/跳过；3 项 Chromium E2E 通过，0 失败/跳过/重试**。新增长期测试 76 项：

| 测试文件 | 项数 | 覆盖 |
|---|---:|---|
| config.test.ts | 12 | 初始空配置、权限与恢复、密钥三态/遮蔽、并发冲突、错误字段、候选隔离、空间身份/切换拒绝、真实写失败、发布隔离与关闭排空 |
| model-url.test.ts | 19 | v1/代理前缀/斜杠、完整 rerank、非法 scheme/凭据/query/metadata/link-local、DNS 地址校验、Retry-After |
| chat.protocol.test.ts | 19 | 请求内容/认证/usage、分包 SSE、JSON 回退、异常/工具/空回复、认证错误、退避/限额、重定向、超时、活动/排队取消、部分流网络错误不重放 |
| embedding.protocol.test.ts | 8 | 输入敏感批量/乱序、重复/缺失/越界/维度/零/非有限、取消停止后续批次 |
| rerank.protocol.test.ts | 9 | 两种标准协议、真实重排、非法结果、禁用不请求、缺配置、显式降级警告/取消 |
| models-api.integration.test.ts | 7 | 空继承环境真实子进程、三个独立端点、候选不保存/不改索引、保存不请求、重启/密钥实传、冲突/CSRF、日志去密与断开取消 |
| config-crash.integration.test.ts | 2 | 配置 rename 前/后的真实子进程 SIGKILL，恢复旧/新完整 revision/model/key，快照不变 |

原 121 项契约、存储/崩溃、CLI、HTTP 和界面测试保留；按实际 S03 更新阶段、编辑能力和提示。原 10 个快照 SIGKILL 边界继续通过。

浏览器 3 项为：空配置导航/刷新；三个候选端点→保存→密钥不回显→真实服务重启→保留绑定→清除密钥并验证实际请求；并发版本冲突→重新加载。断言浏览器未直接请求模型、未使用 localStorage、无页面异常。

首次 lint 发现未使用的解构变量，已修复。补充崩溃测试时误并行启动第二个构建，清理 dist 导致两项崩溃测试失败和一个 UI 测试文件无法导入；保留失败报告后，顺序重跑完整构建/测试，不改弱断言、不跳过用例。机器可读记录见 [s03-validation.json](reference/s03-validation.json)；完整临时报告/截图位于被忽略目录。

## 限制与下一步

三个不同本地 HTTP 假模型验证的是目标协议与生命周期，没有验证外部真实供应商、推理质量或实际费用。连接测试使用明确的小型示例；文本测试输出限制 32 tokens。不承诺所有 OpenAI/Cohere/Jina 原生扩展兼容。

S04–S12 仍待实施，G01–G12 算法参考验收未完成。下一步 S04：所有约定格式在本地解析、Worker、tokenizer 与分块。S03 本地提交后未自动推送。
