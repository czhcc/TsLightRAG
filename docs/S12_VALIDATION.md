# S12：许可、文档与源码交付审查

2026-10-19 完成。本次基于 `1dc9aadd0e51ef94be796024cdf0009b946f08d6`（S11），固定上游仍为 `HKUDS/LightRAG@aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。运行环境 Node 24.19.0/npm 11.9.0、Linux x64 本地 overlayfs、系统 Chromium。机器记录：[s12-validation.json](reference/s12-validation.json)。

## 交付内容

- 顶层 [MIT LICENSE](../LICENSE) 保留 LightRAG Team 版权和 TsLightRAG contributors 归属；[NOTICE](../NOTICE.md) 解释各依赖及资源许可、补充来源和分发边界。[原始来源](UPSTREAM_PROVENANCE.md) 延续逐文件迁移记录。
- [第三方清单](../third_party/dependencies.json) 记录 180 个已安装生产包，附全部收集到的许可/版权原文、PDF.js CMap/ICC/字体/WASM 独立条款及 SHA256；9 个未安装可选平台包单列。`node scripts/licenses.mjs` 离线校验，`--write` 在依赖更新后重新生成。脚本不联网，也不修改业务数据。
- README 更新为当前实现；提供 [启动示例](../examples/startup.json)、[无密钥模型字段示例](../examples/models.json) 及 [操作指南](OPERATIONS.md)，覆盖模型配置→导入→检索/引用→删除→重启，以及费用、外发、明文 key、限额和完整备份/显式回退。模型 JSON 是请求结构参考，不能冒充内部 app.json。
- 未修改应用代码、算法、schema、依赖版本或锁文件。健康接口保留 S11 功能阶段，S12 为源码交付阶段。

## 本次实际执行

| 检查 | 结果 |
|---|---|
| `npm run typecheck` / `npm run lint` / `npm run build` | 均退出 0 |
| 构建后 `npx vitest run --reporter=json --outputFile=.tools/s12-vitest.json` | 71 文件、472 通过、0 失败/跳过；单元/契约/组件 267、集成 205；协议 36 为单元子集，不重复相加 |
| 构建后 `npx playwright test --reporter=json` | 10 通过、0 失败/跳过/flaky；真实浏览器三模型地址、导入、五模式、引用、图谱、共享删除与重启闭环 |
| `node scripts/licenses.mjs --write` 后 `node scripts/licenses.mjs` | 生成及一致性校验均退出 0；180 包/9 未安装可选包 |
| 实际启动示例 + CLI 覆盖 | `parseStartup` 默认路径/端口正确；真实服务使用 `--config examples/startup.json --port 0 --data-dir <临时目录>`、空继承环境启动成功 |
| 模型字段示例 | 由当前 `SaveModelsSchema` 校验通过，不发送请求、不保存到真实配置 |
| 完整备份及还原 | 临时 dataDir 导入合成 TXT，等待 awaiting_configuration；停止服务后 `cp -a --` 完整复制，逐文件 SHA256 相同；新目录 inspect 通过，重启仍有相同文档/状态 |
| 维护故障边界 | 活 writer 下 inspect 拒绝；合成破坏 CURRENT 后 inspect 拒绝；指定 generation 校验成功；缺少确认的 recover 拒绝；确认 recover 后 inspect 成功且生成 CURRENT 备份 |
| 范围/仓库审查 | 四个自有 package.json 均 private；无数据库驱动、远程解析路径、Python 业务子进程或 SDK 发布配置；contracts 的 exports 仅内部 workspace 互用 |
| 忽略与凭据审查 | 受控 Git 文件和待交付文件无 data/cache/build/node_modules/.env；常见 key/私钥模式扫描零命中。API 测试使用合成 key、文档夹具为人工测试内容；未提交个人文档或配置 |
| `git diff --check` | 通过，含暂存的新交付文件 |

操作验证只使用本次拥有的临时进程与 `.tools/` 临时目录，未修改现有 `./data`、未使用真实模型密钥。恢复相关的拒绝错误是预期断言，并非未解释失败。初次 diff 检查发现上游许可的行末空白，已在汇总生成时仅规范化行末空白，原文件 SHA256 仍按原字节记录，修正后检查通过。临时目录在验证后删除，记录只保留布尔结果及汇总。源码关键词扫描不是泄密绝对证明；结合忽略规则、配置边界和 diff 人工审查判断。

本次未重新冷安装、计算覆盖率或重生成 Python 参考，因依赖和业务源码未改变；这些沿用 S11 实际证据，不能算作 S12 又跑了一次。S11 核心覆盖率行 98.17%/分支 83.51%、五组固定 SHA 参考逐字重生成结果见 [完整报告](VALIDATION_REPORT.md)。本轮完整基础测试含这些参考夹具的 TS 断言。

## 实现方案最终门槛逐项签收

以下对应实现方案 §10.2 的 11 项；“通过”指已声明的 Linux 本地、离线合成协议及共同夹具范围。

| 门槛 | 签收依据与限制 |
|---|---|
| 1 安装/构建/测试 | 通过：S11 lockfile 冷安装，本轮 typecheck/lint/build、472 基础测试和 10 E2E；无 `.only`/无解释 skip |
| 2 F01–F13 | 通过：S11 报告逐项实现/测试/观察，S12 浏览器闭环复跑；历史通过不扩展排除范围 |
| 3 覆盖率及故障 | 通过：沿用 S11 行 98.17%/分支 83.51%，高于 85%/80%；本轮重跑存储/模型/索引故障断言 |
| 4 无业务 env/模型配置 | 通过：空 env 真实启动；三独立端点、密钥不回显、重启保留由 E2E 复跑 |
| 5 本地格式及失败 | 通过：九格式、禁网/外链陷阱、坏文件/扫描/空文档拒绝由基础测试复跑；无 OCR |
| 6 模式/重排/预算/引用 | 通过：五模式分支、重排改序、完整预算和最终引用由基础测试/E2E 复跑 |
| 7 删除/缓存/幂等 | 通过：存活共享贡献重建、缓存失效和重复来源不累加由集成与 E2E 复跑；历史代未物理擦除 |
| 8 持久化/崩溃/坏盘 | 通过：真实 SIGKILL 和磁盘错误用例复跑；另执行完整备份还原及显式损坏回退；非物理掉电测试 |
| 9 空间切换/取消 | 通过：同维异模型重建、批次失败旧库可读、流取消断言与浏览器停止复跑 |
| 10 架构/许可/仓库 | 通过：本地存储和禁网解析，无 Python 业务入口/对外 SDK；MIT 及第三方原文保留，运行文件忽略；本项为源码交付审查 |
| 11 G01–G12 | 按明确适配通过：沿用 S11 固定原函数共同夹具参考，本轮 TS 参考断言复跑；VECTOR/WEIGHT、排序/融合等逐项见完整报告；不声称整个 Python 服务或真实生成结果等价 |

## 结论与未验证范围

S00–S12 的本地实现、验收和**源码交付**已完成。S11 完整报告中关于“当时 S12 待办”的记录保留为历史；当前交付结论以本记录和实施状态为准。

真实模型供应商兼容/生成质量/实际费用、非 Linux/NFS、物理掉电、大规模性能、云草稿发布及新任务恢复均未验证。未发布二进制包、容器、预装依赖或 SDK；未来分发这些产物，仍需按 NOTICE 针对原生 canvas/Skia 内嵌组件、字体等核对实际归属和源码提供义务，当前包级原文清单不替代该项。未支持项继续按 README 排除，不算暗中实现。

本阶段只做本地提交；远端推送需用户另行明确要求。
