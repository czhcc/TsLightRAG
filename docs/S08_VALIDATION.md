# S08 验证记录

日期：2026-10-16。基准：`HKUDS/LightRAG@aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a`。本阶段完成检索、上下文与引用预览；回答生成与 NDJSON 属于 S09。

## 当前能力

- `naive` 直接查 chunks；`local` 低层关键词查实体并展开邻边；`global` 高层关键词查关系并取端点；`hybrid` 合并图候选；`mix` 另做独立 chunks 召回。关键词仅为空时，少于 50 个 Unicode 码点的查询回退自身，长查询返回 empty；单侧关键词缺失遵循上游跨模式分支。
- local 保持实体向量序，边按两端 degree 之和、weight 降序；自环 degree 为 2。global 保持关系向量序，端点按首次出现去重。端点方向按实体名称的 Unicode 码点顺序规范化，不把 SHA ID 的字典序当作名称序。
- 图候选 local/global 交错，与文本块 vector/entity/relationship 三路交错分开；每阶段首次出现去重。一般向量库同分仍按既有 ID 顺序；图来源块 VECTOR 同分严格保留来源首次出现顺序。
- 默认 `kgChunkPickMethod=VECTOR`、`relatedChunkNumber=5`；仅对截断后图候选的关联块计算原查询余弦相似度。有效组先去重/统计频次，关系组先排除已选实体块。VECTOR 配额为 `r<=0 || n<=0 ? 0 : max(1,floor(r*n/2))`；WEIGHT 使用线性位置配额、Python ties-to-even 和剩余配额重分配。0 关闭图来源块，不关闭图描述。
- 每次查询捕获稳定的索引快照及其活动 embedding profile/configRevision/spaceId；文本/关键词/重排角色使用捕获的当前配置。候选向量模型变更不会拿新模型查旧索引；并发删除后，已有查询继续读旧完整快照，下一次读新语料。无回答或上下文结果缓存。
- 重排默认关闭，关闭时无 HTTP 请求。开启后真实验证返回 index、唯一性、topN；按 score 排序和阈值过滤后才应用 chunkTopK 与最终预算。故障按配置 fail 或 fallback-with-warning，回退不会被分数阈值误过滤。
- 按实体、关系预算先截断图描述，再按完整请求预算进一步裁图，之后才选来源块。重排之后预算裁文本块；最终重新渲染并计数，包含系统提示、历史、用户指令、查询、引用、消息开销和 maxOutputTokens 回答预留；上限取请求与模型 contextTokens 较小值。固定开销已经超限则 HTTP 400，且不调用模型。
- 引用只来自最终保留块，按文档 ID/发布版本关联，不合并两个同名文件；按块频次、首次出现给引用编号。块保留文档版本、顺序、原始解析 location。界面只呈现真实位置，不推测不存在的页码。

## API 与界面

`POST /api/v1/query/data`，参数由共享 `QuerySchema` 校验。例如：

```json
{"query":"Alpha 如何与 Beta 协作？","mode":"mix","kgChunkPickMethod":"VECTOR","relatedChunkNumber":5,"onlyNeedContext":true}
```

返回 `QueryDataSchema`：status/mode、entities/relationships/chunks、references、context、prompt、content、warnings、diagnostics。diagnostics 包含 generation/corpusRevision、文本配置版本、活动向量配置版本与空间、关键词/cache 命中、实际检索分支、召回数、来源块选择/合并顺序、截断数与完整 token 预算；不返回密钥或内部 profile。

`content` 在 onlyNeedPrompt 时为完整提示词，否则为上下文。数据接口始终同时提供 context/prompt 便于检查；onlyNeedContext 和 onlyNeedPrompt 不能同时开启。接口不执行最终回答模型，未提供假答案。错误、关键词截断/无效 JSON、模型失败均明确返回错误，不冒充空检索。

`/query` 可选择五模式、VECTOR/WEIGHT、关联块数量和可选重排，查看证据正文/原始位置、上下文、完整提示和诊断，可取消在途请求。每次请求单独传递设置，不读业务环境变量。最多 4 个活动检索，和导入/维护/连接测试共享同一个模型客户端的并发与超时控制。进程退出或 HTTP 连接断开传播 AbortSignal。

健康状态 `stage=S08, usable=false`；生成尚未接入，因此不宣称问答已经可用。

## 独立 Python 参考与逐项对应

执行：

```bash
python3 scripts/reference/s08.py /tmp/LightRAG-reference
```

脚本先校验完整 SHA，从原文件 AST 加载并执行完整原函数，而非用 TS 结果生成期望。数据/模型/存储端口采用确定的内存适配器；token 参考使用每 Unicode 码点一个 token 的共同端口，排序并未由适配器替代。需验证环境的 Python 3 和 NumPy（本次 2.3.5）；仅验证用，不进入应用运行或安装脚本。

输出为 `tests/fixtures/graph/s08-python-reference.json`，包含源码 SHA256 和函数名单。`operate.py`/`utils.py` 完整函数覆盖 kg_query 的空关键词/debug 返回、关键词规范化、图谱搜索、本地边排序、全局端点、VECTOR/WEIGHT 来源块、三路合并、图截断、重排→topK→块截断、引用生成与渲染；另执行原始向量内容 f-string。32 组图检索组合加上空关键词 Unicode 边界、缺向量回退、配额重分配、图/块预算与引用样例可重新生成。

| 门槛 | 原执行依据与目标断言 |
|---|---|
| G03 | 原 kg_query 短/长/emoji 边界、normalize、perform_kg_search；真实 HTTP 五模式/关键词缓存、失效响应与单侧回退 |
| G04 | 原 get_node_data/邻边函数；实体序、degree+weight、自环与名称/ID 排序隔离 |
| G05 | 原 get_edge_data/端点函数；向量关系序及端点首次序 |
| G06 | 原 perform_kg_search；四种图模式逐序对照，真实 API 五模式和 mix 仅文本命中 |
| G07 | 原两类 source 函数、quota、weighted_polling/vector_similarity；32 组合、去重、r=0/1、同分、缺向量回退 |
| G08 | 原 merge_all_chunks；直接向量→实体→关系逐轮去重，检查完整 ID 顺序 |
| G09 | 原 apply_token_truncation/process_chunks_unified；共同码点 token 端口的图前缀/重排先序参考；目标完整 BPE 请求预算、最终块/引用裁剪由独立集成测试验证 |
| G10 | 原 entity/relation 内容表达式；真实 HTTP 索引三库字段/规范 ID、L2/维度/空间校验及活动版本配对。以下既有格式适配差异明确保留 |

以上是 **S08 规则范围的参考证据**，不是完整 Python 服务、所有分支或真实模型效果验收。G01/G02 的完整抽取/摘要、G11/G12 及 G01–G12 总验收仍在后续阶段。

## 显式差异

1. 原关键词解析可去围栏、think 并用 json_repair 修复；目标只接收有效 JSON，字段值按上游规范化，非法/截断响应失败且不缓存。关键词缓存为最多 256 条进程内缓存，键含固定提示版本、模型/配置、语言与查询；重启清空，userPrompt 不参与关键词提示或键。
2. 有效索引必须有可解析的活动模型绑定。原来源选择缺 embedding function 时可回退 WEIGHT；目标在查询入口对缺模型返回 409。候选来源向量缺失/异常的纯选择器则按原规则警告并回退 WEIGHT；完整快照校验通常已拒绝这种损坏。
3. WEIGHT 模式只计算当前分支实际需要的 keyword embeddings；不为未使用的原 query 多发 embedding 请求。存储/embedding 故障明确失败，不把失败当作没有证据。
4. 保留 S06 已发布的向量内容格式：实体为 name/type/description，关系为规范 ID 两端名称/keywords/description（换行），块为原文。上游实体为 name/description，关系为 keywords、tab、按名称排序的两端和 description。共同语义字段逐项验证；额外 type、字段顺序/分隔符和 SHA canonical ID 映射已声明，**不承诺输入字节、向量值或真实模型排序与 Python 一致**。本阶段不静默重写既有索引；改格式需显式重建与迁移方案。
5. 全部模式统一使用上游 rag_response 与 kg_query_context 模板；naive 图描述为空。引用以文档 ID/版本替代上游 filename 身份，避免同名文件被误合并。引用编号仍遵循频次/首次顺序。
6. 目标使用本地固定 BPE，进一步计入历史、回答预留和消息框架，精确重渲染后裁剪；不会照搬上游固定 200 buffer 或声称 token 数/保留量逐项相同。预览和真实待生成请求使用相同预算，无法容纳固定开销时显式失败。共同 token 参考验证阶段顺序和原规则，真实 BPE 上界由目标测试保证。

这些差异不替代缺失分支，不把本阶段称为全部 GraphRAG 算法验收。

## 最终验证

- typecheck、lint、生产 build：通过。
- **56 个文件 / 416 项 Vitest 测试，8 项 Chromium E2E，通过，无失败/跳过。** 新增测试覆盖计划要求的检索/排序/来源选择/参考/重排/预算/引用/API，并增加索引字段与关键词规范化检查。
- Chromium：未配置错误→真实 HTTP 模型建索引→五模式检索→来源/原始位置→上下文与提示词，检查无 pageerror；已有浏览器回归全部保留。
- 启动自检使用 S08 产物，保留已有 data/ 的 generation/revision/corpusRevision；不向已保存模型发连接测试或查询。云配置仅更新 start_skill，保留安装/网络/仓库/密钥设置；草稿未发布，新任务恢复未验证。
- 无新增 npm 依赖，无新的冷安装声明；S04 npm ci 证据继续保留。最终报告/源码/产物 hash 见 [s08-validation.json](reference/s08-validation.json)。

期间修正：浏览器首次运行在 select 的精确 label 文本匹配处超时（标签文本包含选项），改为按 combobox 的真实可访问名称定位，保留全部业务断言并重跑。重排测试最初使用了不受支持的 `fallback` 字面值，改为契约已有 `fallback-with-warning`；不是修改故障策略。源码复核发现按 SHA ID 排端点会改变上游名称顺序，补上名称规范化及回归；为避免查询复制全部正文，仅新增只读 KV size 与 edgeById 访问，不改变持久化格式。
