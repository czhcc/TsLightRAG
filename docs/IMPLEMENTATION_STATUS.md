# 实施状态

更新日期：2026-10-19（Asia/Shanghai）。上游固定基准：`HKUDS/LightRAG@aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。

## 当前阶段

| 阶段 | 状态 | 已完成或待办 |
|---|---|---|
| S00 | 已完成分析和初始来源记录 | 两份方案、F01–F13 范围、G01–G12 算法门槛；后续复用文件继续补来源 |
| S01 | 已完成 | npm workspaces、TS strict/ESM、运行时 schema、CLI、HTTP 与 WebUI 基座、测试辅助工具；71 测试 + 1 Chromium E2E 通过 |
| S02 | 已完成 | 内存 KV/向量/无向图、状态和贡献容器、原生 flock、校验快照与离线恢复；121 测试 + 1 Chromium E2E 通过 |
| S03 | 已完成 | 本地模型设置/密钥三态/角色绑定、候选连接测试、文本/向量/重排协议；197 测试 + 3 Chromium E2E 通过 |
| S04 | 已完成 | 九格式本地解析、受限/禁网 Worker、真实夹具、本地 tokenizer 与稳定分块、能力矩阵；263 测试 + 4 Chromium E2E 通过 |
| S05 | 已完成 | 文件/文本导入、hash 去重、原文/解析产物持久化、队列/阶段、幂等重试/取消、退出/重启恢复与文档页面；288 测试 + 5 Chromium E2E 通过 |
| S06 | 已完成 | JSON 抽取/有界修复与补充、合并/摘要、贡献账本、缓存、三类向量与原子发布；322 测试 + 6 Chromium E2E 通过 |
| S07 | 已完成 | 共享贡献删除/清空、版本替换、候选与活动模型版本、三类向量切换、并发/取消/崩溃恢复与文件释放；348 测试 + 7 Chromium E2E 通过 |
| S08 | 已完成（本阶段范围） | 五模式检索、VECTOR/WEIGHT、重排、完整预算与引用预览；416 测试 + 8 Chromium E2E；固定 SHA Python 参考及明确适配差异 |
| S09 | 已完成（本阶段范围） | 非流式/NDJSON 回答、停止/断连取消、受限缓存、固定 Python 生成参考；445 测试 + 9 Chromium E2E |
| S10 | 已完成（本阶段范围） | 图谱实体/关系搜索、限量子图/邻居/来源；文档拖放/过滤、安全 Markdown、引用跳转及完整浏览器闭环；454 测试 + 10 Chromium E2E |
| S11 | 已完成（本地验收；发布/新任务恢复未验证） | 472 基础测试 + 10 E2E；核心覆盖率行 98.17%/分支 83.51%；G01–G12 共同夹具对照及明确适配、实际安装/开发/生产验证 |
| S12 | 已完成（源码交付范围） | 顶层 MIT/LightRAG 归属、180 个已安装生产依赖及 PDF.js 资源许可；无密钥示例、操作/备份恢复指南和最终门槛审查 |

## 后续主机 IP 访问

CLI/启动 JSON 支持显式 IPv4/IPv6 和通配监听；HTTP Host 校验跟随实际启动选项，数字 IP 可用，同源及 DNS Host 保护保留。默认仍为 loopback，无登录认证。源码更新后须重新 build，命令与边界见 [操作指南](OPERATIONS.md#通过主机-ip-访问)，实际验证见 [机器记录](reference/network-access-validation.json)。

## 后续跨平台适配

文件锁更换为带 Windows/macOS/Linux 预编译模块的 fs-ext-extra-prebuilt 2.2.14，移除 fs-ext/@types/fs-ext；Windows 使用 LockFileEx，POSIX 继续 flock，因此 Linux 旧版和新版仍互斥。适配 Windows 目录同步差异及配置 ACL，补文件身份/链接校验和三平台 CI。实际回归结果与实机待验证边界见 [跨平台记录](CROSS_PLATFORM.md)；不将 CI 文件存在当作 Windows/macOS 实测通过。

## S12 交付审查

- 完成顶层 MIT、LightRAG Team 版权和第三方归属；生成 180 个已安装生产依赖及 PDF.js CMap/字体/ICC/WASM 原文与 hash 清单，记录 9 个未安装的可选平台包。`node scripts/licenses.mjs` 可离线核对；源码许可不替代未来预装依赖/原生二进制分发审查。
- README 接通首次安装/使用，新增无密钥启动和模型字段示例、数据外发/费用/明文凭据/限额说明，以及完整备份还原和显式 generation 回退指南。
- 类型检查、lint、构建及测试结果见 [S12 交付记录](S12_VALIDATION.md)。独立临时 dataDir 实测启动、文档持久化、逐文件一致备份/还原、重启、活锁拒绝和损坏指针回退；未使用个人 key，未修改原 dataDir。
- 逐项签收实现方案 11 个最终门槛，沿用 S11 已执行覆盖率及 G01–G12 共同夹具对照，保留适配和外部未验证项。应用健康接口仍为 S11 功能阶段，S12 只补源码交付材料与核对工具。

## S11 历史验收

- 按 lockfile 重装，typecheck/lint/build、正式 unit/protocol/integration/coverage/E2E/reference 命令均通过；**71 文件 / 472 项基础测试、10 项 Chromium E2E，无失败/跳过**。分类结果为单元 267、协议 36（单元子集）、集成 205，不相加重复计数。核心 storage/indexing/retrieval 覆盖率行 98.17%、分支 83.51%，达到 85%/80% 门槛。
- 固定 SHA 五组参考均可逐字重生成。新增完整抽取/补充、node/edge merge、summary、rebuild/cache reader/parser、naive_query 原函数执行；G01–G12 的共同夹具最低断言按已声明适配通过，不声称整个 Python 服务、向量输入字节或真实模型结果相同。
- 修复较短/等长补充描述覆盖原证据的问题：严格更长才替换，Unicode code point 长度对齐；抽取缓存策略身份更新，旧快照 schema 不变。旧索引需用户明确重新索引才采用新抽取结果，不自动产生模型费用。
- 真实 SIGKILL/重启、损坏/未知版本、第二写者、解析禁网/外链陷阱、资源预算、取消/重试/重建/切换、引用及缓存等本轮复跑通过。生产启动/健康阶段为 S11，原 dataDir generation 保留。
- install_script/start_skill 已确认保存并实际执行安装；开发 Vite 代理及生产 HTTP 检查通过。此 runner 需对本次拥有的 concurrently supervisor 发送 SIGTERM 来确保开发子进程退出，已写入启动说明。用户发布和新任务恢复未验证；真实供应商/质量、非 Linux 与 S12 最终交付仍待后续。

详见 [完整验收报告](VALIDATION_REPORT.md)、[机器记录](reference/s11-validation.json)、[可复用配置副本](reference/s11-environment.json)。S11 历史结果保持原样，S12 补充交付见下。

## S10 历史能力与验证

- 模型页保留候选测试、三个独立端点、角色复用、密钥三态与保存冲突；文档页补拖放、名称/状态服务端过滤和来源文档跳转。
- 图谱页真实读取稳定已提交快照，支持实体名称/关系关键词搜索、最多 100 节点/300 边的子图、一层邻居展开、属性、分页来源及刷新。SVG 环形布局与可访问列表替代初始 Sigma 展示选型；不含手工改图或无限全图。
- 查询回答使用 react-markdown 10.1.0，选择性适配固定上游 skipHtml/链接处理，禁原始 HTML、危险链接和图片加载；引用展开并追溯到文档。失败/取消保留部分回答标记。
- 按新 lockfile 重装后 typecheck/lint/build 通过，**70 文件 / 454 测试 + 10 Chromium E2E 全通过，无失败/跳过**。完整浏览器用例配置三个独立本地模型协议服务，完成导入→五模式/重排→回答/停止→图谱/来源→共享删除→重启恢复；浏览器无直连模型、无 localStorage 密钥。
- 当前实际服务启动/健康阶段均为 S10；保留原 dataDir。当时完整 G01–G12 尚待总验收，现有本地共同夹具结果见上述 S11；真实供应商/质量、非 Linux 及最终交付仍未验收。

详见 [S10 验证记录](S10_VALIDATION.md)、[机器记录](reference/s10-validation.json) 与 [来源清单](UPSTREAM_PROVENANCE.md)。

## S09 历史能力与验证

- `/api/v1/query` 与 `/api/v1/query/stream` 真正将最终预算后的实体/关系/文本块/引用、历史和问题发给 query 模型。空证据/调试预览不调用回答模型；未知引用/输出截断明确警告。
- 模型 SSE 转为 NDJSON meta/references/delta/done/error/cancelled，支持分包 Unicode/CRLF/多行/空帧/usage、JSON 转流、断流和超时；停止/断连取消上游，已输出后不重放，唯一终态。网页可生成、查看来源、命中完整缓存和停止。
- 关键词/embedding/回答为 schema 校验的有界 LRU+TTL；回答键覆盖语料、空间、模型配置、模式/预算/重排、问题/历史/指令。仅完整成功交付的无警告回答可缓存；删除/替换/同字节 rebuild/切换失效，旧在途回答不污染新语料。
- 固定 SHA 完整 kg_query 指令/历史/最终上下文传递参考已执行（六例），补 G12 本阶段证据。**64 文件 / 445 测试 + 9 Chromium E2E 通过**，typecheck/lint/build 通过，无新增 npm 依赖。
- 健康阶段 S09，query/embedding 绑定齐备时 usable=true；未验证真实供应商与回答质量。完整 G01/G02、G11 和跨阶段 G01–G12 的当时缺口已由 S11 本地共同夹具对照补充；完整界面联调已由 S10 接入。

详见 [S09 验证记录](S09_VALIDATION.md) 与 [机器记录](reference/s09-validation.json)。本段为 S09 当时记录，最终交付进展见 S12。

## S08 历史能力与验证

- 五模式实际执行不同实体/关系/块召回；local degree/weight、global 向量序、图候选交错与三路块融合独立实现。默认关联块 VECTOR，WEIGHT 可选，配额、首次去重、频次与回退有源码参考。
- 查询固定索引快照与活动向量模型版本，候选模型编辑及并发删除不会混合空间/语料；重排关闭不调用，开启后真实校验索引、分数、topN 和 fail/fallback-with-warning。
- `/api/v1/query/data` 与 `/query` 提供实际证据、位置、图描述、上下文、提示、引用及诊断；包含历史/系统/问题/引用/回答预留的最终预算，尚不调用回答模型。
- 独立执行固定 Python 完整检索/来源选择/图截断/块处理/引用函数并生成夹具，32 图检索组合及边界参考。G03–G10 本阶段规则已有参考与集成证据；向量内容格式、ID/引用身份、严格 JSON 和额外预算保护的差异逐项公布，未宣称 Python 字节/真实模型结果相同。
- **56 文件 / 416 测试 + 8 Chromium E2E 通过**，typecheck/lint/build 通过，无新增 npm 依赖。G01/G02 完整路径、G11/G12 及全部算法总验收仍待后续。

详见 [S08 验证记录](S08_VALIDATION.md) 与 [机器记录](reference/s08-validation.json)。本段为 S08 阶段记录，生成/流式能力已由上述 S09 接入。

## S07 历史能力与验证

- 删除/清空从存活原始贡献重建共享描述、关键词、类型和权重，只重算必要向量；最后来源消失后无孤儿索引。历史仍引用文件时延后释放。
- 重新索引可沿用文件或替换 TXT/Markdown，成功时版本+1；失败、取消或中断继续读旧完整 processed 版本，不重复累加权重。
- 配置候选与快照活动绑定分离，旧配置/密钥版本持久保护；三类向量和新空间绑定原子激活，分批失败保持旧空间。稳定读快照与其 embedding profile 配对，旧读者不会被新的候选设置改写。
- 长期解析/模型计算在提交互斥之外；导入最多三次重算共享候选，维护在 corpus/config/document 冲突时明确失败。后台维护、取消/幂等重试和文件释放有 API 与页面。
- 共享删除、版本替换、不同维度/同维模型/operatorRevision、批次失败、真实提交前后 SIGKILL、文件释放重试/路径拒绝与缺凭据版本拒绝启动均已验证。
- **45 文件 / 348 测试及 7 Chromium E2E 通过，0 失败/跳过**；typecheck/lint/build 通过，无新依赖。固定 SHA Python 非退化关系 rebuild 权重分支四个样例已对照；完整 G01–G12 参考验收仍未完成。

证据见 [S07 验证记录](S07_VALIDATION.md)、[s07-validation.json](reference/s07-validation.json) 和 [来源清单](UPSTREAM_PROVENANCE.md)。本段保留 S07 当时 health.stage=S07、usable=false 的记录；当前能力以上述 S09 为准。原有 S06 记录保留当时领域队列行为，S07 已将模型计算移出提交门。

## S06 历史能力与验证

- 配置齐备后真实调用抽取/向量模型：严格 JSON、完整围栏、每轮最多 100 条/合计 200 条、最多 1 次修复和 1 轮补充；无效/超限/截断/悬空关系明确失败。
- 持久化每块有效原始贡献，名称 NFKC/空白规范化，无向关系去重；描述精确去重/阈值摘要，新来源 strength 累加、独立证据数保底、重复来源不重复加权。
- doc→chunk/entity/relation 与 entity/relation→chunk 正反账本，三类向量保留内容 hash/内容/空间身份；完整索引与 processed 同一最终快照发布，恢复校验来源一致性。
- 有效抽取缓存供失败人工重试复用，错误不缓存；取消、配置变更、并发共享图、embedding/写盘故障、索引最终提交前真实 SIGKILL/SIGTERM 恢复均有测试。
- **37 文件 / 322 测试及 6 Chromium E2E 通过，0 失败/跳过**；typecheck/lint/build 通过。无新增依赖，冷安装证据仍为 S04。
- 独立执行固定 SHA 的 Python 规范化/描述去重/来源权重辅助规则，输出及源码 hash 入库；只覆盖部分 G01/G02，完整算法门槛尚未验收。上游提示词及 MIT 许可已保留。

证据见 [S06 验证记录](S06_VALIDATION.md)、[s06-validation.json](reference/s06-validation.json) 和 [来源清单](UPSTREAM_PROVENANCE.md)。health.stage=S06、usable=false；删除/重新索引/空间切换待 S07，检索与生成待 S08/S09，旧 awaiting_indexing 需手动重试，不自动模型收费。

## S05 历史能力与验证

- 真实 multipart/TXT/Markdown 导入；原文原子发布并提交文档/任务后才 202，hash 去重与显示名/磁盘键分离；非法名字、额外 multipart 字段、symlink 和配额明确拒绝。
- Worker 解析/分块进度持久化，产物受限保存并校验；无模型停 awaiting_configuration，模型齐备停 awaiting_indexing，S06 尚未接入，不报 processed、不发模型请求。
- 2 活动/10 待处理任务、有界文档/历史/原文/产物；分页、详情/解析预览、任务查询、幂等取消和 expectedJobId 重试；文档页面轮询实际事实。
- SIGTERM 停止接收并中断，SIGKILL 后在监听前标 interrupted；原文/任务保留，失败/停靠状态不自动重跑。已完成索引取消不会撤销贡献。
- 原文/产物失败、快照发布前后错误、queued 202 即刻强杀和缺失/损坏拒绝启动已验证；只管理文档不递增 corpusRevision。
- **29 文件 / 288 测试和 5 Chromium E2E 通过，0 失败/跳过**；新增 25 项业务/故障/取消测试。typecheck/lint/build 通过；未改依赖，冷安装沿用 S04 记录。

证据见 [S05 验证记录](S05_VALIDATION.md) 与 [s05-validation.json](reference/s05-validation.json)。完整图谱索引、任务中的模型调用及 GraphRAG 仍待 S06 后实施；保留快照/未引用文件，无自动 GC。

## S04 历史能力与验证

- 统一 ParsedDocument/Block、规范化正文偏移及可用来源位置；TXT/Markdown/HTML/CSV/JSON、PDF 文本层和 DOCX/XLSX/PPTX 全部本地解析。
- ZIP 声明/实际大小、项数、路径、CRC、加密位；XML DTD/XXE、深度/节点和各格式预算检查。不执行外链、脚本、公式或宏；扫描/空/坏文件明确失败。
- 可终止、限时/限 V8 堆的 Worker，2 个活动/8 个等待；禁用网络入口，超时/取消释放队列。prepareDocument 将解析与分块一起移出主事件循环。
- 固定 js-tiktoken 1.0.21，两种本地 encoding；默认窗口 1200/最大重叠 100，Unicode 边界、稳定 chunk ID、实际 tokens、规范化正文跨度和来源映射。
- 工作台与能力 API 展示九格式范围及资源限制；上传/任务仍在 S05，health stage=S04、usable=false。
- 冷 npm ci、typecheck/lint/build、**24 文件 / 263 测试和 4 Chromium E2E 全通过，0 失败/跳过**。包含 66 项新增解析/安全/分块测试和此前完整回归；实际 Worker 低堆失败、禁网和原 12 个 SIGKILL 边界通过。npm audit 当次 0 已报告漏洞。

证据见 [S04 验证记录](S04_VALIDATION.md) 与 [s04-validation.json](reference/s04-validation.json)。格式矩阵有明确降级；Worker 不是 OS RSS/恶意代码执行沙箱。尚未执行全部格式变体、真实外部模型或完整知识库闭环验收。

## S03 历史能力与验证

- 模型设置页可增删 profile、配置独立地址/协议/参数、绑定角色、测试候选、保存和处理冲突。extract/keyword 默认复用 query；rerank 可禁用。
- 配置 `<dataDir>/config/app.json`，无业务环境变量。串行 expectedRevision、密钥省略保留/null 清除/字符串替换；目录 0700/文件 0600、原子写盘。GET/响应/普通日志不回传 key，保存后浏览器清空密码框。
- OpenAI-compatible 文本/embedding 与标准 Cohere/Jina-compatible rerank；真实分包 SSE、index 校验/批量、明确降级警告、限流/有限重试/超时/取消。候选测试不保存、不改索引；保存不暗中请求模型。
- URL 保留代理前缀，rerank 使用完整 endpoint；DNS 答案校验并固定连接、阻止 metadata/link-local/重定向、保持 TLS、限制请求与响应；延续同源/Host 检查。
- 生成选中配置的 embeddingSpaceId；非空索引更换空间或修改 profile/凭据需 S07，当前拒绝。配置捕获与快照相互独立，尚未实施自动重建/激活。
- 最终 **20 文件 / 197 测试，3 Chromium E2E 全通过，0 失败/跳过**；包括 76 项新增协议/配置/真实 API 测试、配置 rename 前后两个真实 SIGKILL，以及原 10 个快照崩溃边界。typecheck/lint/build 通过，未新增依赖。
- 健康接口 stage=S03，按已保存绑定报告模型缺项；文档/索引/检索仍未实现，所以 usable=false。

证据见 [S03 验证记录](S03_VALIDATION.md) 与 [s03-validation.json](reference/s03-validation.json)。本地协议测试不代表所有外部供应商兼容或推理质量。S01/S02 记录为历史阶段证据。

## S02 历史能力与验证

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

可配置模型、导入九格式文档、解析分块并建立实体/关系/块三类索引，持久查看/取消/重试任务，重启保留结果。已支持删除/重新索引及三类向量重建切换；S08 已实现五模式检索、重排、预算和引用预览，S09 已接入回答、NDJSON、取消和受限缓存。S10 已完成图谱与页面闭环；S11 本地验证和 G01–G12 最低共同夹具对照已完成，适配与未验证项见完整报告。

**S00–S12 本地范围和源码交付已完成。** 保持无业务环境变量、仅本地存储/解析、不发布 SDK 的约定；云环境发布/新任务恢复、真实供应商/质量、非 Linux 及二进制产物额外许可核对仍未验证，不纳入本地源码交付结论。
