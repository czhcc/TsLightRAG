# S09 验证记录

日期：2026-10-16（Asia/Shanghai）。固定源码基准：`HKUDS/LightRAG@aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。

本阶段完成回答生成、NDJSON、停止/断连取消及有界查询缓存；保留 S08 五模式、图谱排序、来源选择、预算和快照配对。完整图谱页面和使用体验整合仍属 S10。

## 生成与引用

`QueryService.withSession` 在同一同步捕获点取得查询参数、稳定索引视图、活动 embedding 版本和当前文本/关键词/重排配置，贯穿检索、生成和缓存身份。最多 4 个活动查询覆盖整个生成与发送过程，共享已有 ModelClient 并发、DNS/TLS、超时、有限重试及 AbortSignal；不在存储写队列中等待模型。

S08 返回的最终实体/关系/块/引用进入同一套 `generationMessages`，既用于预算也用于实际发送，包含历史与当前问题。用户指令槽对齐原 `resolve_user_prompt`：非空前置两个换行，空值为 `n/a`；不使用环境前缀。固定系统模板要求只根据 Context 作答、引用已有 Reference Document List ID。

- 无证据返回明确“未找到”与空引用，不调用回答模型；onlyNeedContext/onlyNeedPrompt 返回 preview，也不调用回答模型。
- 图谱描述存在但未保留文本块时仍可生成，明确警告没有可引用的文本块，不编造引用。
- 检测数值、分组数值及 DC 编号的不存在引用，保留原回答并警告，不自动替换或创建来源。引用目录表示检索证据，不保证模型每句话正确有据。
- `finish_reason=length` 明确标记可能不完整，不写回答缓存。错误响应不当作成功字符串。浏览器用 React 文本节点显示回答，不执行模型/文档 HTML。

## API 与终态

| 接口 | 行为 |
|---|---|
| `POST /api/v1/query` | 非流式 `QueryResponseSchema`：answer/mode/status/finishReason/references/warnings/cached/data |
| `POST /api/v1/query/stream` | UTF-8 `application/x-ndjson`，每个事件一行；参数同 QuerySchema |
| `POST /api/v1/query/:id/cancel` | 使用 meta.requestId 停止仍活动的流，返回 cancelled boolean；未知或已退场请求返回 false |
| `POST /api/v1/query/data` | 保留纯检索预览，不调用最终回答模型 |

正常流为 `meta → references → delta* → done`。done 带 finishReason/warnings/cached/status 与最终 data。错误为 error，取消为 cancelled；准备阶段错误可能直接以 error 终止。结构错误在开启流之前返回普通 HTTP 400。每个请求由一个协调器选择唯一终态，终态后不再发送 delta 或另一个终态。

服务端把模型 SSE 解码成自己的 NDJSON，复用已验证的 ModelClient：支持跨包 UTF-8、CRLF、多行 data、空 delta、usage-only、正常 [DONE]、返回 JSON 的模型与失败/超时。已交付 delta 后网络失败不自动重试，不重复 token。大 delta 分段时不切断 surrogate pair。NDJSON 写者处理背压、错误和关闭；终态写出失败不安装回答缓存。

停止接口会中止上游 fetch 并向仍连接的客户端写 cancelled。浏览器停止也中止自身 fetch；若连接已断开，服务端不能保证客户端收到 cancelled 行，客户端保留“部分内容/已取消”状态。完成/停止竞态只保留已选终态；已完成请求不能追加取消事件。SIGTERM 的共享退出信号同样中止查询。

非流式在响应 finish 后、流式在终态写出完成后才允许发布缓存；这是服务端发送完成，不是客户端业务读取确认。同 key 在终态交付阶段遇到的请求等候该次发布决定，避免 EOF 与缓存提交微任务竞态；不合并尚在模型计算中的同问请求。应用原有 HTTP 空闲连接超时仍适用，模型 timeout 不覆盖该边界。

## 缓存与一致性

抽取缓存继续使用 S06 的持久化机制。本阶段三类查询缓存均为进程内、有 schema 的 LRU（容量按序列化 UTF-8 字节计数）：

| 缓存 | 上限 | TTL | 身份 |
|---|---|---|---|
| 关键词 | 256 条 / 8 MiB | 15 分钟 | 提示版本、语言、模型/配置与 query；不含不会传给关键词模型的 history/userPrompt |
| query embedding | 256 条 / 8 MiB | 15 分钟 | embedding profile、活动 spaceId、有序原问题/关键词输入；校验有限、非零、维度一致 |
| 回答 | 64 条 / 16 MiB，单条 ≤1 MiB | 15 分钟 | 提示版本、corpusRevision、活动空间、完整模型/绑定/配置和全部标准化 Query 参数 |

回答身份包含模式、topK/chunkTopK、图/总预算、来源策略/数量、重排/阈值、问题、历史、用户指令；非流式和流式共享完整结果缓存。缓存键只保留 SHA256，不把私密配置串写进日志。读取/写入隔离可变对象，失效/过期惰性移除并按 LRU 驱逐，重启全部清空。

回答缓存仅接受 success、stop、无警告且完成交付的结果；empty、preview、失败、取消、截断/部分流、无效引用/降级警告不写入。完成的有效关键词/embedding 子结果可复用，即使后续回答失败；失败或取消的模型子结果本身不缓存。

语料/配置变更后新查询清空旧回答作用域。生成结束再检查语料与配置版本，旧快照的在途回答可按原快照完成，但不能装入新语料缓存。成功 rebuild 即使生成完全相同的向量字节，也将 processed rebuild ID 纳入 corpusIdentity，使 corpusRevision 前进；普通进度/缓存元数据仍不会改语料版本。没有持久化格式变更，旧快照仍可加载。删除、替换版本、空间切换均通过原子语料变化使旧回答失效。

## Python 参考与来源

运行：

```bash
python3 scripts/reference/s09.py /tmp/LightRAG-reference
```

脚本校验完整 SHA，独立执行原完整 `kg_query`、`_answer_cache_kv`、EffectiveUserPrompt/resolve_user_prompt、原 hash/identity 序列化函数，并读原 rag_response 模板。检索使用固定上下文端口（其检索规则在 S08 已独立执行）；缓存端口关闭，模型只记录收到的系统/历史/问题。六个用例覆盖默认/中文/含花括号指令、历史、context/prompt bypass、空检索无回答调用，生成 `tests/fixtures/graph/s09-python-reference.json`。TypeScript 比较实际共享消息构造，API 测试另检查真实 HTTP 请求确实接收同一最终上下文。

这补充 G12 的最终上下文→模型/引用传递证据，**不表示完整 G01–G12 总验收已经完成**。S08 已声明的向量内容/规范 ID、严格 JSON、naive 统一模板及更严格预算差异继续适用。

新编写的缓存、HTTP/NDJSON、停止接口、浏览器帧解析与状态由本仓库方案驱动，不复制上游 router/UI。原提示词及派生参考适用 [LightRAG MIT 许可](../third_party/LightRAG/LICENSE)。目标缓存更严格：上游有历史时绕过回答缓存，目标将历史纳入 key；目标等待自身 NDJSON 完整终态，加入语料/空间/配置隔离并拒绝带警告结果，不照搬上游缓存或响应字符串清理逻辑。没有 Python 业务运行依赖或新 npm 依赖。

## 最终验证

- typecheck、lint、生产 build 通过；**64 文件 / 445 测试 + 9 Chromium E2E 全部通过，无失败/跳过**。
- 真实 TCP：分包 UTF-8/CRLF/多行/空 delta/usage-only、JSON 转流、EOF/网络失败、超时、唯一终态、显式停止与断连传播、完整缓存跨协议重放；流已输出后网络失败不重试。
- 缓存：完整命中零模型调用；关键词/embedding 独立命中；history、instructions、预算、模式、来源策略/数量、重排及模型配置区分；删除/版本替换/同字节 rebuild/空间激活失效；旧在途完成不写新库。
- Chromium：配置和索引后实际流式回答/引用→完整缓存→停止上游并标记部分内容→相同问题重新生成；检查无 pageerror。S01–S08 浏览器与故障回归保留。
- 重新执行 S09 Python 参考可确定重生成；应用启动自检保留原 data/ 的 generation/revision/corpusRevision。健康 stage=S09，usable 随 query/embedding 绑定是否齐备；不代表已验证外部模型提供商或知识库回答质量。
- 云环境沿用 setup 工作流，只更新已执行的 start_skill；安装/网络/仓库/密钥配置保留，未发布草稿或验证新任务恢复。无新冷安装声明。

记录见 [s09-validation.json](reference/s09-validation.json)。初轮流缓存测试使用 HTTP 注入器，其模拟 raw close 的 writableFinished 为 false；改用真实 TCP 验证发送完成和缓存，未放宽真实连接关闭保护。参考脚本首次遗漏 json 名称空间，补齐标准库端口后通过。完整 G01/G02、G11 及整体跨阶段验收仍在 S11，真实提供商/检索质量未验收。
