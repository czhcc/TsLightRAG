# S04 本地解析与 token 分块验证

日期：2026-10-15。S04 交付九种格式的本地解析、统一正文/定位、受限 Worker、本地 tokenizer 和稳定分块。文档上传、任务持久化和索引仍由 S05/S06 实施。

## 当前入口与能力

应用内部 `parseDocument(bytes, fileName, options)` 返回 `{format,parserVersion,text,blocks,metadata,warnings}`；`prepareDocument(bytes,fileName,chunkOptions,options)` 在**同一 Worker** 中完成解析及分块，供 S05 使用。不是对外 SDK，不增加上传或即时索引接口。

正文是各块用两个换行连接的规范化文本；块 start/end 是该正文中的 UTF-16 偏移，**不是原始 PDF/Office/二进制文件的字节位置**。契约验证正文、块文本、连续起止偏移一致；metadata 含原文件 SHA-256。可用时保留行、段落、标题路径、页、工作表/行、幻灯片、表格行和 JSON Pointer。

`GET /api/v1/parsers/capabilities` 返回与工作台相同的实际格式矩阵、限制和排除项。健康阶段更新为 S04；usable=false，尚不能上传文档或执行知识库问答。

| 格式 | 已实现 | 明确边界 |
|---|---|---|
| TXT | 严格 UTF-8、BOM/CRLF 规范化、段落与行号 | 拒绝非法编码/二进制控制字符，不猜测 GBK 等编码 |
| Markdown | remark AST、标题路径、段落/列表/代码与源行 | 链接只取文本，图片只取 alt；内嵌 HTML 忽略并警告，不下载资源 |
| HTML | parse5 静态 AST、标题/正文/列表/表格行 | 不执行脚本；忽略 script/style/head/iframe/object 等；不加载资源，不充当浏览器渲染器 |
| CSV | 引号、逗号、跨行字段、记录/结束行定位 | 限行列；不执行公式；字段数不一致/引号损坏明确失败 |
| JSON | 严格 JSON、稳定对象键顺序、数组原顺序、JSON Pointer 转义 | 限深度/节点；拒绝非有限数值，空容器不空成功，不执行字符串 |
| PDF | PDF.js 本地文本层、页码、中文/emoji ToUnicode | 近似阅读顺序；无文本页警告，全无文本返回 NEEDS_OCR；加密/损坏失败，无 OCR/XFA/脚本执行 |
| DOCX | ZIP/XML 预检、正文段落/样式标题/表格顺序 | UTF-8 OOXML；不含 smart heading、页眉页脚、图片/嵌入对象语义、修订删除文本 |
| XLSX | 工作簿关系、工作表/行/单元格引用、共享/内联字符串、布尔与数值 | 有公式缓存用缓存，无缓存保留公式并警告；不计算公式、不执行宏/连接；日期/数值显示样式保持原始值 |
| PPTX | slide 数字顺序、XML 内文本、组形状和表格 | 明确按 slide2→slide10 数字编号，不承诺视觉/演示顺序、母版/备注/图片语义 |

Office 使用新编写的受限 OOXML 提取器，不引入 Mammoth/ExcelJS 的整套转换或公式执行能力；这是方案允许的本地 OOXML 路径，输出限制在上述矩阵范围。旧 DOC/XLS/PPT、DOCM 等扩展不支持。CFB 头返回“不支持加密或旧二进制 Office 容器”，不声称解密或区分所有 CFB 变体。

## 预算与隔离

默认限制在共享常量和能力 API 中定义，调用方只可收紧，不可放宽：

| 资源 | 默认上限 |
|---|---:|
| 输入文件 | 20 MiB |
| ZIP 全部项解压总量 / 单项 | 100 MiB / 20 MiB |
| ZIP 项 | 10,000 |
| 规范化文本 / 输出块 | 2,000,000 UTF-16 字符 / 50,000 |
| 结构深度 / 节点 | 64 / 200,000（XML 按部分，HTML/Markdown/JSON 按文档） |
| 表格行 / 列 | 50,000 / 512 |
| PDF 页 / 工作表 / 幻灯片数量 | 500 |
| 排队、解析和可选分块总超时 | 60 秒 |
| 活动 Worker / 等待队列 | 2 / 8 |
| 单 Worker V8 old/young heap、stack | 256 MiB / 32 MiB / 4 MiB |

- ZIP 先检查 central directory 的项数、声明大小、重复名、路径/深度、symlink、加密位及压缩方式；随后流式解压，校验实际大小、累计预算与 CRC，不把 ZIP 解压到文件系统。
- 所有 XML/relationships（包括未提取的部分）先经过 SAX 预检/预算；拒绝 DTD/ENTITY、格式错误、过深/过多节点，再进入格式提取。不解析外部实体。
- 解析只接收有界 bytes 和显示文件名，文件名不作为文件系统路径；不直接写数据库、配置或索引。错误不输出文档原文、路径或库私有异常。
- Worker 在加载解析器之前禁用 fetch、HTTP(S)、TCP/TLS、HTTP2、UDP 及主要 DNS 入口，PDF 只用 bytes 和包内本地 cmap/font/wasm 资源；不启用网络解析器。依赖只解析静态内容，不执行文档代码。
- 超时、取消和 Worker 错误都会终止 Worker、排空监听并释放 admission slot；丢弃第三方 stdout/stderr，避免源数据进入普通日志。
- Worker/V8 限制与 ZIP/文本预算不等于 OS 总 RSS/原生库硬内存沙箱，也不承诺执行恶意代码后的隔离。仅 Linux 本地环境已验证；物理内存极端压力、所有畸形 PDF/Office 和生产负载未全面验证。

## tokenizer 与分块

固定 `js-tiktoken@1.0.21`，词表随 npm 包本地安装，支持 `cl100k_base`（默认）和 `o200k_base`；无运行时下载。共享 `countTokens` 供后续检索预算使用；特殊 token 字样按普通文本处理。

默认窗口 1200 tokens、最大重叠 100，要求 `0 <= overlap < window`，窗口上限 16,384。在完整 Unicode 边界结束/重叠，再以同一 tokenizer 复核实际 token 数；不会用 U+FFFD 替换半个中文/emoji。窗口小到不能容纳一个完整字符时返回 `CHUNK_WINDOW_TOO_SMALL`。重叠最多为指定数，边界必要时减少，保证前进。

Chunk 包含 docId/docVersion/order、正文起止、实际 tokens、相交来源块与定位、chunker/tokenizer 版本。ID 的 SHA-256 包含文档身份/版本、源 hash、分块版本/encoding/参数、正文跨度与内容；相同输入稳定，不同文档/版本隔离。来源位置指向规范化解析块，不伪造原文件偏移。实际模型 tokenizer 与所选编码是否相符需供应商另行确认；完整请求预算在 S08 实施。

## 实际验证

冷安装后顺序执行并通过：

```bash
npm_config_devdir="$PWD/.cache/node-gyp" npm ci --no-audit --no-fund
npm run typecheck
npm run lint
npm test -- --reporter=json --outputFile=.tools/s04-vitest.json
npx playwright test --reporter=json > .tools/s04-playwright.json
npm audit --json
```

`npm_config_devdir` 仅用于 S02 原生锁的构建缓存，不是业务变量。保持 TLS/完整性验证；npm 11.9.0 的透传配置警告沿用 S02 说明。

最终 **24 文件 / 263 测试，0 失败/跳过；4 Chromium E2E，0 失败/跳过/重试**。原 197 项保留（阶段断言更新为 S04），新增 66 项：

| 文件 | 项数 | 内容 |
|---|---:|---|
| formats.test.ts | 35 | 9 格式真实小文件与正文/定位 golden、中文、空/坏文件、编码、扫描/加密 PDF、Office 内容顺序/缓存/组形状、JSON 数组顺序 |
| parser-security.test.ts | 13 | traversal/symlink/重复项、加密位、项数/解压预算/虚报大小、CRC、XXE、结构深度/节点、页/行列/文本限制、宏不执行、超时/取消及队列上限 |
| parser-no-network.test.ts | 4 | 所有格式在禁网 Worker 下解析、HTML/Markdown/Office 外链 0 请求、实际网络入口拒绝探针、真实低堆 Worker 失败且父进程存活 |
| chunker.test.ts | 14 | 本地双编码计数、普通特殊 token 文本、中文/emoji/补充平面 Unicode、窗口/重叠、完整尾部、稳定 ID、位置映射、非法/空输入、双编码 Worker 内一致性 |

浏览器保留 3 项模型/基座流程，新增真实生产页面和能力 API 的九格式/预算/限制检查；确认上传接口仍不存在，没有伪造文档处理。原 12 个快照/配置 SIGKILL 边界继续通过。

夹具与生成说明见 [tests/fixtures/documents](../tests/fixtures/documents/README.md)，无需 Python、网络下载、真实模型 key 或个人文档。PDF 为实际 xref/页树/文本及图片对象，Office 为实际 ZIP/OOXML；安全变体在测试中构造。来源/位置预期文件不在运行时用解析结果生成。CFB 仅为拒绝签名探针，宏夹具为不会执行的合成 payload，未冒称真实 VBA/所有加密文件覆盖。

首次类型检查发现流/DNS/csv-parse 类型和 PDF.js 6 已移除选项的差异，按实际接口修复。lint 控制字符正则检查改为显式字符码验证，未关闭规则。首轮 250 项有 1 项失败，揭示结束偏移超出正文未被拒绝，已修复契约后完整重跑。后续补充数组顺序、队列/堆限额与第二 encoding 的 Worker 验证，最终冷安装 263 项全通过。审计当次 0 已报告漏洞。

完整报告/截图在忽略目录；摘要、命令及源/夹具/构建 hash 见 [s04-validation.json](reference/s04-validation.json)。依赖许可见 [来源清单](UPSTREAM_PROVENANCE.md)。启动说明已同步云环境草稿，保存不代表发布或新任务恢复验证。

## 下一步

S05 接入上传落盘、持久化任务、取消/重试、解析结果和状态；使用 prepareDocument，避免主线程执行 CPU 分块。S06 再接入模型抽取/向量和一致索引提交。S07 非空空间切换及 G01–G12 GraphRAG 算法验收仍待实施。S04 完成本地提交，不自动推送。
