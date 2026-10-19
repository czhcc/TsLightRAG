# 许可与第三方归属

TsLightRAG 源码按顶层 [MIT LICENSE](LICENSE) 分发。LightRAG 派生算法、提示词、参考夹具与选择性 UI 适配保留 `Copyright (c) 2025 LightRAG Team`；固定源提交、原路径和修改见 [来源清单](docs/UPSTREAM_PROVENANCE.md)，原 MIT 全文见 [third_party/LightRAG/LICENSE](third_party/LightRAG/LICENSE)。其他依赖和资源沿用其各自许可。

[dependencies.json](third_party/dependencies.json) 记录当前 lockfile、Linux x64 安装实际存在的生产依赖版本、许可标签、原文路径和 SHA256。[THIRD_PARTY_NOTICES.txt](third_party/THIRD_PARTY_NOTICES.txt) 保留这些许可/版权全文，包含传递依赖；汇总时只移除行末空白，清单 SHA256 对应原始文件字节。`node scripts/licenses.mjs` 离线校验；更新依赖后运行 `node scripts/licenses.mjs --write` 并审查变化。缺少必要包、许可或版本不符会失败。未安装的可选平台包单独列出，不声称已核对其二进制内容。

主要直接运行依赖：Fastify、@fastify/multipart、@fastify/static、csv-parse、fs-ext-extra-prebuilt、js-tiktoken、parse5、remark-parse、unified、yauzl、zod、React、React DOM、react-markdown 为 MIT；saxes 为 ISC；PDF.js 为 Apache-2.0。依赖版本以清单和 lockfile 为准。锁库从 fs-ext 更换为 fs-ext-extra-prebuilt 2.2.14（MIT，WordPress Playground team / Matt Sergeant 来源）；保留 POSIX flock，并提供 Windows LockFileEx 和预编译模块。

PDF.js **资源各有许可**：CMap 的 Adobe BSD 条款、ICC 的资源许可、Foxit 字体许可、Liberation 的 GPLv2 加字体例外，以及 OpenJPEG/JBIG2/QCMS 和 PDF.js WASM 包装许可均保留在全文中；不得用包级 Apache-2.0 标签覆盖。字体许可的嵌入例外不等于任意二进制分发豁免。

部分 npm 压缩包遗漏许可证，补充来源如下：

| 包 | 补充文本和来源 |
|---|---|
| js-tiktoken 1.0.21 | [原文](third_party/supplemental/js-tiktoken-LICENSE)，npm gitHead `4c8b748e07992c00386f3180af5c574b27b65139` 的 [dqbd/tiktoken/LICENSE](https://github.com/dqbd/tiktoken/blob/4c8b748e07992c00386f3180af5c574b27b65139/LICENSE)；包含 OpenAI/Shantanu Jain 版权 |
| saxes 6.0.0 | [原文](third_party/supplemental/saxes-LICENSE)，npm gitHead `211fa0ebec9b628affc09219199639887174bfc3` 的 [lddubeau/saxes/LICENSE](https://github.com/lddubeau/saxes/blob/211fa0ebec9b628affc09219199639887174bfc3/LICENSE)，包含继承的 sax-js 归属 |
| abstract-logging 2.0.1 | 包 README 明确链接 `http://jsumners.mit-license.org/`，package.json 声明 MIT、作者 James Sumners；[补充文本](third_party/supplemental/abstract-logging-LICENSE) 为标准 MIT 条款和该作者归属，不冒充从不可访问的旧站逐字取得的历史文件，不猜测版权年份 |
| fs-ext-extra-prebuilt 2.2.14 | npm 包未包含声明的 LICENSE.txt；[补充原文](third_party/supplemental/fs-ext-extra-prebuilt-LICENSE.txt) 来自 npm gitHead `43f4655ab079ae4e9399bf0e3c00c65925c66f6e` 的 [LICENSE.txt](https://github.com/adamziel/fs-ext-prebuilt/blob/43f4655ab079ae4e9399bf0e3c00c65925c66f6e/LICENSE.txt)，与源码头部条款一致 |
| @napi-rs/canvas 的已安装 Linux 平台包 | 同版本主包的 MIT LICENSE；不代表已核对原生 Skia 及其全部内嵌组件 |

本阶段交付源码及 npm lockfile，未交付预装 node_modules、容器或二进制安装包。若分发 Web 构建、依赖目录、字体、WASM 或原生库，随产物携带本 NOTICE、适用原文，并针对**实际产物**核对额外来源/源码提供义务；特别是原生 canvas/Skia 内嵌组件及 GPL 字体，不能以此清单替代产物审查。开发/测试工具及独立 Python 参考环境不在生产清单中；若一并分发，同样需附其许可。当前无 SDK 发布配置。
