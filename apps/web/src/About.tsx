import { PARSER_CAPABILITIES } from '@tslightrag/contracts';

export function About() {
  return <>
    <section aria-label="系统介绍">
      <h2>关于 TsLightRAG</h2>
      <p>TsLightRAG 是面向本地单用户知识库的文档管理、图谱增强检索和问答系统。将文档解析为文本块，抽取实体与关系，结合向量检索与知识图谱，为回答提供可追溯的文档来源。</p>
      <ul>
        <li>文档管理：上传文件或导入文本，查看处理进度、预览内容并维护索引。</li>
        <li>知识问答：新建和切换对话、连续追问、流式回答、停止生成与查看来源，对话历史保存在服务端。</li>
        <li>检索与图谱：支持 naive、local、global、hybrid、mix 五种检索模式，可选重排，并可浏览实体、关系和原文证据。</li>
        <li>模型配置：独立配置文本、向量和重排服务，支持兼容接口、连接测试及文本模型扩展参数。</li>
      </ul>
      <p>文档解析、索引和对话记录保存在当前服务的数据目录。使用外部模型时，问题、相关正文及对话上下文会发送到你配置的接口；本地解析不代表模型推理也在本机完成。</p>
    </section>
    <section aria-label="本地解析能力">
      <h2>本地解析能力</h2><p>以下格式可在文档页面上传、本地解析和查看结果。</p>
      <table><thead><tr><th>格式</th><th>当前能力与限制</th></tr></thead><tbody>
        {PARSER_CAPABILITIES.formats.map(f => <tr key={f.format}><td>{f.label}</td><td>{f.scope}</td></tr>)}
      </tbody></table>
      <p>单文件 {PARSER_CAPABILITIES.limits.inputBytes / 1024 / 1024} MiB；解压总量 {PARSER_CAPABILITIES.limits.zipBytes / 1024 / 1024} MiB；最多 {PARSER_CAPABILITIES.limits.zipEntries} 个 ZIP 项；文本 {PARSER_CAPABILITIES.limits.textChars} 字符；解析含分块限时 {PARSER_CAPABILITIES.limits.timeoutMs / 1000} 秒。</p>
      <p>不支持：{PARSER_CAPABILITIES.exclusions.join('、')}。</p>
    </section>
  </>;
}
