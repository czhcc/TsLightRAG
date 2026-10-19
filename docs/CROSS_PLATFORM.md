# Windows / macOS / Linux 适配

本次将 Linux 专用的 fs-ext 2.1.1 更换为 **fs-ext-extra-prebuilt 2.2.14**，移除 @types/fs-ext，使用包内类型。锁仍由内核持有，关闭句柄/进程退出释放；没有 PID 存活猜测、心跳过期抢锁或可并发写入的无锁回退。

| 平台 | 锁及持久化行为 | 当前验证状态 |
|---|---|---|
| Linux 本地磁盘 | flock、文件 fsync、目录 fsync、同目录 rename | 已执行本地安装/构建/基础与浏览器测试，结果见下 |
| macOS 本地磁盘 | flock、文件/目录同步、同目录 rename | 已适配并加入 CI，未取得实机结果 |
| Windows 本地 NTFS | LockFileEx、文件 FlushFileBuffers、同目录 rename；Node 不提供可用的目录 fsync | 已适配并加入 CI，未取得实机结果；不承诺与 POSIX 相同的断电语义 |

不保证 NFS/SMB、网络盘、跨主机共享写入或物理掉电场景。这里的“适配”不等于已在所有系统实测通过。

## 原生 Windows 安装

安装 Git、Node.js **24.19.0** 和 npm **11.9.0**。在自己的用户目录下 clone；使用 PowerShell 或命令提示符，以下 `npm.cmd` 也可避免 PowerShell 限制执行 npm.ps1 的问题：

```powershell
git clone https://github.com/czhcc/TsLightRAG.git
cd TsLightRAG
npm.cmd ci
npm.cmd run build
npm.cmd start
```

浏览器访问 `http://127.0.0.1:9621`。无需 WSL，也无需为业务配置环境变量。模型设置、导入和问答步骤见 [操作指南](OPERATIONS.md)；外部模型调用可能发送正文/问题并计费。

也可用 pnpm 10.34.7（当前仅在 Linux 实际验证 pnpm 流程），Windows PowerShell 命令为：

```powershell
npm.cmd install --global pnpm@10.34.7
pnpm.cmd install --frozen-lockfile
pnpm.cmd run build
pnpm.cmd run start --host 0.0.0.0 --port 9621 --data-dir ./data
```

pnpm 参数无需额外 `--`；默认仅本机访问时使用 `pnpm.cmd run start`。Corepack 与双锁文件说明见 [pnpm 操作说明](OPERATIONS.md#pnpm-安装构建与启动)。

锁库随包提供 Node 24 的 Windows/macOS/Linux x64、arm64 预编译模块，正常加载时不需要本机 C++/make/Python。若预编译包与系统/Node ABI 不匹配，安装器会尝试 node-gyp；该回退才需要 Python 和平台编译工具（Windows 为 Visual Studio C++ Build Tools）。不匹配时应保留安装错误诊断，不能手动关闭锁来启动。不要跨系统复制 node_modules，分别运行 npm ci。

macOS/Linux 使用 README 的 npm 命令。Python 源码参考验证是独立开发工具，不是业务入口；当前参考准备流程仍以已验收的 Linux 环境为准。

## 文件锁与升级

保留同一路径 `<dataDir>/locks/writer/lease`，POSIX 仍调用 flock，所以新旧 Linux 进程互斥，不会因换成另一个不兼容的锁域而同时写库。仍须先停止旧服务再升级依赖/启动新版；同库的 inspect/recover 也使用同一锁。

锁不是依据文件内容判断的。PID、时间、文件年龄和伪造 owner 元数据都不能抢占活锁；Windows 字节范围锁还会拒绝其他句柄写 lease。永久保留 lease 文件，不能删除它来“解锁”。锁库加载或内核加锁失败时拒绝写入。

读取快照、原文、配置和 lease 时校验常规文件身份，拒绝 symlink/可识别的重解析点；没有 O_NOFOLLOW 的平台增加 lstat 与打开句柄身份比较。原子新建仍用 O_EXCL。运行目录必须由当前用户控制，不把应用当作对抗同账号恶意进程的 OS 沙箱。

## 凭据与平台差异

POSIX 继续使用配置目录 0700、文件 0600，并拒绝宽松的配置文件权限。Windows 不把虚拟的 mode 位当作权限证明：在加载配置前，通过系统自带 **Windows PowerShell/.NET ACL API** 为 config 目录、已有配置和版本文件设置当前 Windows 账号专属的受保护 DACL；新文件继承该目录规则。遇到链接/重解析点、无法设置 ACL 或系统工具被策略禁用时拒绝加载配置。使用非交互、无 profile 的编码命令和固定系统工具路径，不调用 shell、不传密钥，不增加 Python 或远程解析依赖。

凭据仍是本机明文，不是加密保险库；Windows 本机管理员仍可通过系统权限接管文件。原文、快照和备份也须放在当前账号控制的私有目录。备份还原后首次启动会重新保护配置树。

Windows 的文件内容写完仍执行 sync，CURRENT 仍以同目录 rename 发布，损坏和未知 schema 仍拒绝启动。由于 Node 不支持该平台的目录 fsync，目录同步函数只验证目录，不伪称已刷新目录；发布后出现故障时，`durabilityConfirmed` 不会被标为 true。进程终止/重启与物理掉电是不同场景，Windows 后者没有本次验收结论。

## Windows 备份与还原

先结束任务并退出服务，确认使用同一 dataDir 的进程已停止。完整备份整个目录，保留配置版本、原文、产物、所有快照与 CURRENT；不要在线只复制 generations。备份路径应在当前账号的私有磁盘中。

以下 PowerShell 使用 robocopy 的 `/COPY:DATS` 保留数据、属性、时间及 DACL，`/XJ` 避免遍历目录 junction；退出码 0–7 表示成功/差异，≥8 才是复制失败。每次选用全新目标，不合并到旧备份：

```powershell
npm.cmd run storage:inspect -- --data-dir ./data
$backup = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'TsLightRAG-backup-01'
if (Test-Path -LiteralPath $backup) { throw '备份目标已存在，请使用新路径' }
robocopy .\data $backup /E /COPY:DATS /DCOPY:DAT /XJ /R:0 /W:0
if ($LASTEXITCODE -ge 8) { throw '备份复制失败' }

$restored = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'TsLightRAG-restored-01'
if (Test-Path -LiteralPath $restored) { throw '还原目标已存在，请使用新路径' }
robocopy $backup $restored /E /COPY:DATS /DCOPY:DAT /XJ /R:0 /W:0
if ($LASTEXITCODE -ge 8) { throw '还原复制失败' }
npm.cmd run storage:inspect -- --data-dir $restored
npm.cmd start -- --port 9622 --data-dir $restored
```

不要跨账号直接复用原 DACL；需要换账号时由有权限的管理员明确迁移归属，再用目标账号验证。损坏回退仍按操作指南选择 generation 并传 `--confirm-data-loss`；它不同于完整备份还原。上述 Windows 命令等待实机验证，不算本次 Linux 执行结果。

## 验证和 CI

[三平台 CI](../.github/workflows/platforms.yml) 在 ubuntu-latest、windows-latest、macos-latest 执行 npm ci、类型检查、lint、构建，真实内核锁/同进程和跨进程互斥、SIGKILL 后释放、快照与配置提交前后强杀、损坏恢复及 Unicode/引号路径测试。Windows 额外读取真实配置 DACL，断言当前账号专属、无继承宽松授权；浏览器执行三模型配置→导入→五模式/引用→共享删除→重启用例。

Linux 特有的旧版 flock 互操作测试在其他平台明确不运行。CI 配置在本次提交中，尚未推送运行，因此不宣称 Windows/macOS 已通过。Linux 本次实际命令/数量/覆盖率见 [机器记录](reference/cross-platform-validation.json)，S02/S11/S12 的历史证据保留当时的 Linux 范围。

本轮 Linux 冷 `npm ci --foreground-scripts` 确认加载 `fs-ext-linux-x64-node-24.0.0.node`，未调用编译；typecheck/lint/build 通过。构建后执行 `npx vitest run --coverage`：72 文件、477 通过、0 失败/跳过，核心行覆盖率 97.72%、分支 83.46%；`npx playwright test`：10 通过、0 失败/跳过/flaky。新用例包含新旧 flock 双向互斥、恢复后模型密钥保留/不回显、中文/引号路径、损坏 CURRENT 显式恢复、发布后故障隔离及真实 rename 失败。首次新增夹具因绑定不存在的 rerank profile 失败，已修正夹具为不绑定重排，随后全部通过，未放宽业务断言。
