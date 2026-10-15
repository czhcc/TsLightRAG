# S01 验证记录

日期：2026-10-15（Asia/Shanghai）。本记录只证明工程与测试基座，不证明 RAG、模型调用、文档处理或文件数据库已可用。

## 工具与依赖

Linux x64，Node.js 24.19.0，npm 11.9.0；依赖固定在 `package-lock.json`。

| 工具 | 本次版本 |
|---|---|
| TypeScript / Zod | 6.0.3 / 4.6.7 |
| Fastify / static / multipart | 5.12.7 / 10.1.6 / 10.1.3 |
| React / Vite / React plugin | 19.3.1 / 8.3.4 / 6.1.2 |
| Vitest / jsdom | 5.0.4 / 30.1.2 |
| Playwright | 1.64.1，使用本机 `/usr/bin/chromium` |
| ESLint / typescript-eslint | 10.12.0 / 8.71.2 |

选择 TS 6.0.3 是因为本次 typescript-eslint 的 peer 范围为 `<6.1.0`，没有盲目选择 registry 最新 TS 7。安装、构建未关闭 TLS 或完整性检查。

## 已执行检查

在仓库根目录执行以下命令，全部完成且退出码为 0：

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

- `npm test` 包括 clean、TypeScript 构建和 Vite 生产构建，然后执行 **6 个测试文件、71 项测试：71 通过，0 失败，0 跳过**。
- `npm run test:e2e` 在构建后执行 **1 项 Chromium 测试：1 通过，0 失败，0 跳过**。服务使用独立临时 dataDir、动态端口和无继承业务环境；用完退出码 0 并清理。
- 71 项测试在 `npm ci` 重新安装后再次通过；最终机器可读结果来自当前文件集合，见 `docs/reference/s01-validation.json`。
- 额外验证 `npm run dev`：服务端 9621，Vite 5174，带 Origin 的同源代理健康请求、TSX 转换、Chromium 访问模型设置成功。只停止了本次创建的进程组。
- npm audit 检查本次锁定依赖为 0 已报告漏洞；这是执行时 registry 数据，不是永久安全保证。
- 浏览器验证真实生产 JS/CSS 加载、工作台→设置导航、直接路由刷新、状态 API、没有页面异常或第三方请求；截图只保存在被忽略的 test-results。
- 已实际运行 `npm start -- --host 127.0.0.1 --port 0 --data-dir ./data`，验证 npm 转发 CLI 参数、动态端口和健康响应；该次验证进程已关闭。另按保存的启动脚本启动本地 9621 服务并验证健康、模型设置 API 与静态页面。
- 已成功保存环境草稿的 `install_script` 与 `start_skill`，包含安装构建、启动、真实 HTTP 就绪检查及只停止拥有的进程说明；没有发布或验证新任务恢复。用户需要在环境设置审阅保存并发布后才能激活草稿配置。

## 测试覆盖的行为

- 查询的五模式与 VECTOR/5 默认值；空、超长、未知字段、非法预算、错误历史角色和冲突 debug 参数拒绝。
- public 模型配置不含 key、HTTP(S) 地址限制、profile 唯一性与角色类型、维度与并发要求。
- 文档 hash/时间/版本、任务 attempt、图谱证据与有限权重、引用来源、NDJSON 联合事件及非法混合字段。
- CLI 默认值与路径、启动 JSON 和参数优先级、非法端口/非 loopback/未知参数、坏配置去密、help。
- 真实 HTTP 200 健康但 unusable；模型列表为空且不可编辑；静态页面/脚本 MIME；未知 API/资源 404；Origin/Host 403；未实现接口不假装保存成功。
- 空环境和故意设置无效 HOST/PORT/合成 OPENAI_API_KEY 的子进程均不改变业务默认配置；测试 key 不是用户凭据。
- UI 加载/失败/重试、请求 abort、模型角色说明与设置入口；客户端 schema 防止坏健康响应被当成就绪。
- 真实 HTTP 假模型夹具对不同输入返回不同结果并记录 URL/header/body；临时目录相互隔离。

## 初次失败及修正

1. npm 默认缓存位于不可写 home，查询失败；改用工作区缓存，工程 `.npmrc` 保存 `.cache/npm`，后续安装及 npm ci 成功。
2. 首轮类型检查发现 Fastify 错误值为 unknown；增加安全类型收窄。测试配置的 CSS side-effect import 缺类型，补充标准 Vite client 声明。最终全部类型检查通过。
3. 首轮 lint 发现正则不必要转义，修正后通过。
4. 首轮 68 项测试中 67 通过、1 失败：Fetch 没有将手写 Host header 发到 wire，导致恶意 Host 测试失真。独立 inject 核实服务实际拒绝后，测试改用 node:http 发真实 Host，仍要求 403；没有弱化服务检查或断言。新增客户端测试后最终为 71 通过。
5. 第一次开发环境端口预检发现 5173 已被既有服务占用，在启动本项目之前退出；使用本工程 5174，既有进程未更改。
6. 开发代理探测在后端启动前出现短暂 ECONNREFUSED；等待真实健康响应后，代理和浏览器验证通过，不将初期端口开放当成就绪。

初次失败日志与最终运行日志的摘要指纹记录在机器可读证据中；失败不计入最终通过数。

## 复用与限制

- 生产：`npm run build` 后 `npm start -- --host 127.0.0.1 --port 9621 --data-dir ./data`；启动日志输出结构化 listening 信息。内部探测 `/api/v1/health` 与 `/api/v1/settings/models`，确认 S01/空配置，不能等待尚未实现的 usable=true。
- 开发：`npm run dev`；验证 Vite 5174 的 API 代理与设置页面。端口冲突时检查占用，不能自动杀其他项目进程。
- SIGTERM/SIGINT 关闭本进程服务；测试仅清理自己创建的目录/子进程。S01 不创建或清空业务 dataDir。
- 浏览器工具、操作系统依赖不由业务代码自动安装；无系统 Chromium 时按 README 安装 Playwright Chromium。
- 没有运行真实模型、解析或 GraphRAG 测试，因为相应业务尚未实现；不以“无密钥”为由跳过应有的基座测试。
- 尚未验证 Windows/macOS、全量业务、生产负载、新任务快照恢复。环境配置草稿与当前机器验证是不同结果；后续发布由用户在环境设置操作。
