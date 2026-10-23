# 安装、使用与备份恢复

本指南面向本地磁盘、单用户、单写者；Windows/macOS/Linux 适配与验证状态见 [跨平台说明](CROSS_PLATFORM.md)。先按 [README](../README.md) 安装 Node 24.19.0/npm 11.9.0 并执行 `npm ci && npm run build`。预编译锁模块可正常加载时无需本地编译工具。不需要配置业务环境变量或个人模型密钥才能启动和运行离线测试。安装时 node-gyp 缓存、headers 路径属于构建配置；受限 home 的云环境可用 `npm_config_devdir="$PWD/.cache/node-gyp" npm ci`，有本机 headers 时按平台配置 npm 的构建选项。

## pnpm 安装、构建与启动

可选择 pnpm **10.34.7**，仍需 Node 24.19.0/npm 11.9.0（构建脚本内部使用 npm）。仓库已有 pnpm workspace 和从 npm 导入的锁；使用全局 pnpm CLI 或 npx 直接运行，保持 package.json 中默认 npm 设置：

```bash
npm install --global pnpm@10.34.7
pnpm install --frozen-lockfile
pnpm run build
pnpm run start --host 127.0.0.1 --port 9621 --data-dir ./data
```

主机 IP 访问改为 `pnpm run start --host 0.0.0.0 --port 9621 --data-dir ./data`，配置文件为 `pnpm run start --config examples/startup.json`，开发模式为 `pnpm run dev`。参数不加 npm 风格的额外 `--`；维护命令同理：`pnpm run storage:inspect --data-dir ./data`。Windows PowerShell 可写成 pnpm.cmd。

若 Corepack 因默认 npm 拦截 pnpm，可把 pnpm 替换为 `npx --yes pnpm@10.34.7`，例如 `npx --yes pnpm@10.34.7 run build`。直接 pnpm CLI 的 “WARN This project is configured to use npm” 是可继续的提示。不要混用两种管理器的 node_modules；切换安装方式时停止服务并移除 node_modules，再按对应锁安装，保留整个 dataDir。依赖更新时先用 npm 更新 package-lock.json，再执行 `pnpm import` 并审查 pnpm-lock.yaml；不是每次使用都重新 import 锁。内部 npm 命令可能提示 pnpm 配置相关的 warn，本次固定版本的安装和构建均退出 0。

## 启动与配置示例

在仓库根目录执行：

```bash
npm start -- --config examples/startup.json
```

浏览器打开 `http://127.0.0.1:9621`。示例只包含 host/port/dataDir；CLI 参数优先，例如 `npm start -- --config examples/startup.json --port 9622 --data-dir ./data/demo`。不同进程必须使用不同 dataDir；不要在原数据目录下另开服务。所有相对路径按仓库根目录解释，默认数据为 `./data`。本地应用无账号系统，默认 loopback；需要网络访问时显式启用并限制为受信任客户端。

[examples/models.json](../examples/models.json) 是无密钥的 **SaveModels 请求结构参考**，供对照模型设置字段；界面没有“导入 JSON”按钮。它不是 `--config` 文件，也不是可直接复制为 `config/app.json` 的持久格式。地址均为不可用的 `.invalid` 占位符，模型名称、contextTokens 和维度必须替换为实际服务的值；1536 仅演示。不要向占位地址测试。重排示例未绑定，按需选用；extract/keyword 为 null 时复用 query。expectedRevision 仅演示新配置版本 0，编辑已有配置须使用当前 revision。

在 `/settings/models` 添加文本、向量、可选重排模型，填写独立地址、模型名和所需密钥，选择 query 和 embedding 绑定，保存。文本/向量地址为 base URL，追加 `/chat/completions`、`/embeddings`；重排为完整 endpoint。候选测试会发送示例并可能计费；保存本身不调用模型。无需通过手工修改内部 JSON 绕过版本校验。密钥省略保留、清除删除；修改地址必须重新输入或明确清除旧密钥。

### 文本模型连接测试

vLLM 的 Base URL 通常以 `/v1` 结尾，程序实际发送 `POST /v1/chat/completions`；不要把完整 `/chat/completions` 路径再填进 Base URL。模型名称填写 vLLM 实际发布的 ID（可通过 `/v1/models` 查看，或核对服务端 served-model-name）。

连接测试使用当前配置的最大输出 token，不再隐藏地强制为 32。思考模型可能先消耗预算生成 reasoning，而尚未输出 content；应根据模型上下文/资源限额提高输出预算，或在模型服务端调整思考模式。点击测试会实际调用模型，可能计费，不自动保存候选或修改索引。

- `MODEL_OUTPUT_LIMIT`：响应以 length 结束但没有回答正文。不能把 reasoning_content 当成回答，也不应报协议测试成功。
- `INVALID_MODEL_RESPONSE`：响应不是有效 JSON、不是 Chat Completions 结构，或没有有效正文/结束原因；提示会说明基本要求。请核对地址、模型协议和服务端响应结构。
- 空 `tool_calls`、`function_call`、`usage` 可作为未提供值处理；实际工具调用、拒答、只有思考内容而无正文、坏格式仍不接受。非空正文达到输出上限时，连接测试通过但明确提示预算警告。

错误不回显供应商原始响应、key、正文或思考内容。若继续失败，可提供删去这些内容后的字段结构及新的错误提示；真实供应商兼容结果不能由本地模拟用例替代。

### 文本模型的上下文与输出预算

“上下文 token”填写模型服务实际支持的输入与输出总容量；“最大输出 token”是为回答保留的上限，两者不是独立的容量。模型设置页会显示扣除输出预留后剩余的最大输入预算，系统提示、问题、历史和检索证据共同使用这部分空间。

检索预览与问答未显式指定预算时，使用 query 绑定模型的 `contextTokens`，不再受隐藏的 16000 token 默认上限限制。例如上下文为 `32768`、最大输出为 `26384` 时，最大输入预算为 `6384` token，其中还需扣除提示词开销。已有配置不需要迁移或重新建立索引，更新构建并重启后生效。

API 请求仍可显式指定 `maxTotalTokens` 限制单次总预算，实际预算为 `min(maxTotalTokens, contextTokens)`；省略时使用 `contextTokens`。检索证据会在预算内裁剪；若不含检索证据的提示词、问题、历史和输出预留已经超限，则在调用模型前返回 `QUERY_BUDGET_EXCEEDED`，说明输入、输出预留和总预算数值。

不要把上下文容量填写得超过 vLLM 的实际限制。输出预留过大时，可降低最大输出或将 query 和 extract 绑定到分别配置的文本模型（可使用同一服务和模型 ID），为问答保留足够的输入空间。Token 数由所选 tokenizer 估算，服务端实际计数可能有差异。

### 文本模型扩展参数

在文本模型的“扩展参数（JSON 对象）”中填写 OpenAI 兼容服务支持的额外聊天请求字段。例如，服务的聊天模板支持该参数时，可关闭思考模式：

```json
{
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

界面填写上述对象本身，不要再包裹 `extraBody` 或 `extra_body`。程序将其合并到 `/chat/completions` 请求 JSON 的顶层。连接测试使用当前编辑值但不保存；点击“保存配置”后，使用该文本模型的实体关系抽取、关键词提取、摘要和问答都会携带这些参数，包含流式请求。若 extract 单独绑定了其他模型，需在该模型上配置；为空时复用 query。

扩展参数随模型配置版本持久保存，重新加载和重启后保留；留空并保存可清除。旧配置没有该字段时行为不变。API 字段为文本模型的 `extraBody`，是可选 JSON 对象，每个模型最多 16 KiB。不要在其中填写密钥，扩展参数会在设置页面和配置查询中显示。模型、消息、温度、输出 token 预算、流式设置、返回数量及工具调用字段由程序管理，不能通过扩展参数覆盖（`model`、`messages`、`temperature`、`max_tokens`、`max_completion_tokens`、`stream`、`stream_options`、`n`、`tools`、`tool_choice`、`functions`、`function_call`）。

参数是否有效取决于 vLLM 版本和模型聊天模板；程序会发送该字段，不保证服务一定支持关闭思考。保存后请手动重试原失败文档，以采用新配置版本。关闭思考也不保证解决全部截断或超时，仍需按实际响应调整输出预算与超时。

## 通过主机 IP 访问

旧版 CLI 和 HTTP Host 都仅支持 loopback。更新源码后必须重新构建，`npm start` 本身不会编译，否则 dist 仍会报“仅允许 loopback”：

```bash
npm run build
npm start -- --host 0.0.0.0 --port 9621 --data-dir ./data
```

Windows PowerShell 可将 `npm` 写成 `npm.cmd`。先正常停止使用此 dataDir 的旧服务，避免第二写者冲突。也可以绑定 `--host 192.168.1.20` 这样的实际网卡 IP；`--host ::` 用于 IPv6 通配监听。启动 JSON 的 host 字段支持相同规则，CLI 优先。不要把网卡 IP 占位值直接照抄为自己的地址。

其他电脑访问 `http://服务器实际IP:9621`，IPv6 使用 `http://[IPv6地址]:9621`。0.0.0.0/:: 是监听通配地址，不是分享给其他电脑的地址；主机防火墙需允许 TCP 9621，客户端到主机还需要网络可达。

默认 loopback 隔离保持不变；显式通配监听允许以数字 IP 作为 HTTP Host（包含 NAT 转发的 IP），指定网卡监听则接受该 IP。任意 DNS 名称继续拒绝，避免关闭原有 Host 保护；Origin 仍必须与访问地址完全同源，cross-site 请求继续拒绝。这次不支持用域名/HTTPS 反向代理绕过校验，不增加 CORS 通配规则。开发 Vite 仍默认只在本机 5174 提供服务，网络访问建议使用上述生产入口。

应用没有登录认证；网络上的可访问客户端可以配置模型、查询和操作文档，因此仅开放给受信任的网络/客户端。

HTTP 主机 IP 通常不属于浏览器安全上下文，可能没有 crypto.randomUUID。模型设置页已改用 HTTP 下可用的 crypto.getRandomValues 生成随机标识，原有配置继续保留。若添加模型仍报 `crypto.randomUUID is not a function`，请拉取修复、重新 build、重启服务并刷新页面，避免继续运行已打开页面中的旧脚本。

## 首次完整使用

1. 在模型页保存 query/embedding；按需测试三个不同地址。测试通过只证明该次协议请求，不代表抽取或生成质量。
2. 到 `/documents` 点击“导入文档”或“粘贴文本”，在弹窗中上传带文本层文件，或输入短 TXT/Markdown，例如“星河公司研发本地检索系统。林青负责星河公司的知识库。”等待状态“已索引”。点击列表行的“查看”打开任务详情弹窗，可查看阶段、失败原因、解析正文、取消或重试；关闭弹窗不会取消后台任务。缺模型时停靠待配置，保存后手动重试，不会自动收费重跑。
3. 到 `/query` 输入“谁负责星河公司的知识库？”，先检索证据，再生成回答，展开引用检查原文/位置。模型可能未抽出图谱，或返回不可靠回答；可用 naive 检查文本块召回。空证据不会调用回答模型编造答案。
4. 到 `/graph` 输入实体名称或关系关键词后搜索，首次进入不加载对象。搜索结果累积加入关联图，双击实体扩展一层邻居；可切换力导向、环形、网格和层级布局。每次请求最多 100 节点/300 边，当前页面累计最多 500 节点/1500 边及 100 次不同探索；下方实体、关系表各自分页，默认 10 行/页，可选 10/20/50/100。选择对象查看属性和来源；“刷新图谱”重新核对已探索结果，清理删除或不再匹配的对象，“清空图谱”重新开始。
5. 文档列表每行提供“查看”“删除”“重新索引”。点击“删除”后在弹窗中确认，等待列表显示任务完成，再重新查询核对存活来源。删除从当前索引撤销贡献并使旧查询缓存失效，历史快照/旧凭据仍可能保留，不等于物理擦除。“重新索引”仅对已索引且有原文件的文档可用，确认后沿用原文件重建，失败保留旧索引；进度在列表和任务详情弹窗查看。页面不再展示独立的“索引维护”面板。
6. 停止自己启动的服务，等待退出，再用相同命令/dataDir 启动。模型绑定、未删除文档与已提交索引保留，删除结果保留；在途任务标 interrupted，需人工重试。不要重复导入来代替恢复。

前台生产进程正常 Ctrl+C/SIGTERM 退出并释放锁。开发模式 `npm run dev` 同时启动 9621 服务和 5174 Vite；本云 runner 的 TTY Ctrl+C 曾未传递到 concurrently，应保留本次 supervisor PID，对它发送 SIGTERM 并确认两个端口均释放，再重启。只停止自己拥有的进程，避免按名称批量 kill。维护前仍有第二写者时命令应明确失败，不能删除 lease 文件抢锁。

## 知识问答与对话历史

从菜单进入“知识问答”（`/chat`），点击“新建对话”。左侧切换历史对话，右侧输入问题、查看流式回答及来源。支持连续追问、停止生成和删除对话；“检索预览”入口继续保留。

每轮可选择“检索模式”（naive/local/global/hybrid/mix）、“来源块选择”（VECTOR/WEIGHT）、“关联块数量”和“启用重排”。选项随发送的问题保存，下次打开对话恢复最后一次发送时的选项；使用重排需先配置并绑定重排模型。发送问题时才调用模型，新建或查看历史不调用模型。

对话记录保存在服务端同一 dataDir 的工作区快照中，包含问题、回答、来源、检索选项和完成/失败/取消状态；刷新、切换浏览器或正常重启后仍可查看，完整 dataDir 备份包含这些记录。记录为本地明文，不在浏览器 localStorage 存储。当前应用仍是单用户工作区，能访问该服务的客户端共享对话历史。

追问仅携带本对话已完成且未被输出上限截断的问答，失败、取消和中断的内容仍可查看，但不进入后续模型上下文。最多选取最近 50 轮有效历史；单条历史回答进入模型时最多 20000 字符。若超出 query 模型上下文预算，会继续移除最早的历史轮次并给出提示，完整记录不会因此删除。每轮始终针对当前知识库检索，历史来源文档删除后，旧引用可能无法再打开。

每个工作区最多 200 段对话，每段最多 100 轮；单条回答记录上限 1 Mi 字符，累计记录超过 64 MiB 后不再接受新问题，需删除旧对话或新建 dataDir。单次活跃生成期间不能重复发送或删除当前对话。服务重启后，在途回答标记“中断”，不会自动收费重跑。正常完成、失败、取消或断连时保存本轮已接收内容；进程异常退出可能丢失该轮尚未保存的部分正文，但问题和在途标记已持久化。

对话写入不会更改语料版本或重建索引。旧工作区没有对话字段时按空历史读取；写入对话后的快照需使用支持该功能的版本打开。不要用旧版程序覆盖新快照。

## 数据与外发

解析、分块、快照和检索索引位于本机，不把原始二进制交给远程解析器。索引会把正文块、抽取提示、实体/关系描述发给 extract/query/embedding，必要时发送摘要和修复/补充请求；查询会发送问题、关键词、候选证据、图上下文、所提供历史与指令到绑定的模型，重排接收问题及候选正文。检索预览也可能调用关键词/embedding/重排。全部传输经服务端执行，调用费用取决于配置的服务；“本地解析”不意味着模型推理离线。

`<dataDir>/config/app.json` 与 `config/versions/` 是权限受限明文（POSIX 目录 0700/文件 0600，Windows 当前账号专属 ACL），包含候选和仍被活动快照引用的旧凭据。备份同样敏感。模型配置不通过 `.env`，浏览器不持久保存 key；不要把个人地址、密钥、文档或备份提交到 Git。默认 `data/`、`.tools/`、`.cache/`、`.env*` 和测试/构建产物已忽略；自定义目录若放仓库内，应自行加入 `.git/info/exclude`，或置于仓库外。

全量图谱、KV 和向量进入内存，向量检索线性扫描；并发和快照序列化增加 RAM/磁盘成本，无大规模性能承诺。当前单文件 20 MiB、正文 200 万字符，ZIP 解包 100 MiB/10,000 项；最多 1000 文档、5000 任务、2 活动任务、10 活动/排队任务，原文和关联解析产物各 256 MiB，单快照 namespace 文件 256 MiB。历史代、旧配置和未知文件不自动 GC，实际磁盘可超过这些限额，需自行监测。扫描件/OCR、加密文件和复杂版面精确还原不支持。

Windows 的文件内容同步仍执行，但 Node 不提供可用的目录 fsync；当前不声明 Windows 目录元数据已持久落盘。断电保证和 POSIX 不同，细节见跨平台说明。下面的 `cp -a`/`test` 示例适用于 POSIX shell；原生 Windows 在停止写入后使用 [Windows 备份命令](CROSS_PLATFORM.md#windows-备份与还原)。

## 完整备份与还原

先结束任务并停止使用此 dataDir 的所有服务，等进程退出。在线直接复制可能得到混合时间点；仅复制 CURRENT 或 generations 会遗漏原文、解析产物、配置及旧密钥版本。以下默认在仓库根目录，备份留在被忽略的 `.tools/`；长期备份请转移到受控磁盘并保护访问权限。

```bash
# 服务已停止；该只读命令也会取得排他锁并校验当前快照：
npm run storage:inspect -- --data-dir ./data
mkdir -p .tools/backups
# 使用全新目录名，避免覆盖已有备份；cp -a 保留权限：
test ! -e .tools/backups/data-backup-01 && cp -a -- ./data .tools/backups/data-backup-01
```

每次使用未存在的备份目录；若目标已存在，检查命令失败且不执行复制。还原到一个**全新目录**，不覆盖原 dataDir：

```bash
test ! -e .tools/restored-data-01 && cp -a -- .tools/backups/data-backup-01 .tools/restored-data-01
npm run storage:inspect -- --data-dir .tools/restored-data-01
npm start -- --port 9622 --data-dir .tools/restored-data-01
```

检查模型绑定、文档、图谱和查询后，再决定未来启动使用哪个目录。先只做本地检查；向恢复的真实模型发送查询也可能计费。完整备份保留所有凭据版本和旧文档；停止写入期间不要同时运行迁移/恢复。源码升级前保留备份，未知 schema 必须停下核对版本，不用空库覆盖。

## 损坏时显式回退快照

这与完整备份还原不同：选定旧 generation 会丢失之后提交的变更。先停止原服务并复制整个损坏目录留存诊断；不要编辑快照、删除锁或反复重试写入。查看 `<dataDir>/workspace/default/generations/`，逐一校验候选 ID：

```bash
npm run storage:inspect -- --data-dir ./data --generation <generation-id>
npm run storage:recover -- --data-dir ./data --generation <generation-id> --confirm-data-loss
npm run storage:inspect -- --data-dir ./data
```

把 `<generation-id>` 替换为实际通过校验的 ID，不连尖括号复制。recover 使用同一排他锁，备份已有 CURRENT 后才切换目标；没有自动选择旧代、损坏静默回退或重新创建空库。保留原目录和备份，待确认数据后再处理磁盘空间。

## 离线验收与交付边界

按 README 运行 typecheck/lint/test/E2E；测试在独立临时目录启动本地 HTTP 假模型，不需要个人密钥。固定 Python 源码参考环境仅用于算法对照，准备方式见 [scripts/reference/README.md](../scripts/reference/README.md)，与业务入口分离。许可离线核对：`node scripts/licenses.mjs`。

已验收 Linux 本地文件系统、合成协议/文档和共同算法夹具。真实供应商兼容、生成质量/费用、非 Linux/NFS、物理掉电和大数据规模未验证。云安装与启动配置已保存为待发布草稿；用户发布及新任务恢复尚未验证。详见 [S12 交付记录](S12_VALIDATION.md) 和 [S11 完整报告](VALIDATION_REPORT.md)。
