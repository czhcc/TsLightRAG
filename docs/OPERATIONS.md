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

## 首次完整使用

1. 在模型页保存 query/embedding；按需测试三个不同地址。测试通过只证明该次协议请求，不代表抽取或生成质量。
2. 到 `/documents` 上传带文本层文件，或粘贴短 TXT/Markdown，例如“星河公司研发本地检索系统。林青负责星河公司的知识库。”等待状态“已索引”。缺模型时停靠待配置，保存后手动重试；失败查看错误后重试，不会自动收费重跑。
3. 到 `/query` 输入“谁负责星河公司的知识库？”，先检索证据，再生成回答，展开引用检查原文/位置。模型可能未抽出图谱，或返回不可靠回答；可用 naive 检查文本块召回。空证据不会调用回答模型编造答案。
4. 到 `/graph` 搜索实体，查看属性和来源；视图最多 100 节点/300 边，只支持一层邻居替换视图。
5. 保留一篇文档、明确勾选确认删除另一篇，重新查询核对存活来源。删除从当前索引撤销贡献并使旧查询缓存失效，历史快照/旧凭据仍可能保留，不等于物理擦除。
6. 停止自己启动的服务，等待退出，再用相同命令/dataDir 启动。模型绑定、未删除文档与已提交索引保留，删除结果保留；在途任务标 interrupted，需人工重试。不要重复导入来代替恢复。

前台生产进程正常 Ctrl+C/SIGTERM 退出并释放锁。开发模式 `npm run dev` 同时启动 9621 服务和 5174 Vite；本云 runner 的 TTY Ctrl+C 曾未传递到 concurrently，应保留本次 supervisor PID，对它发送 SIGTERM 并确认两个端口均释放，再重启。只停止自己拥有的进程，避免按名称批量 kill。维护前仍有第二写者时命令应明确失败，不能删除 lease 文件抢锁。

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
