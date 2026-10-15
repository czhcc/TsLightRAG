# 本地解析合成夹具

全部文件由本仓库新编写的 `../build-documents.mjs` 确定性生成，无用户文档、下载资产或上游测试结果。命令：`node tests/fixtures/build-documents.mjs`。`expected.json` 按夹具内容维护预期正文和定位；不在测试运行时从解析器输出生成预期。

- TXT/Markdown/HTML/CSV/JSON：UTF-8 中文、emoji、标题、外链、不执行的脚本、引号与跨行记录、JSON Pointer 转义。
- DOCX/XLSX/PPTX：真实 ZIP/OOXML 小文件。DOCX 段落/标题与表格前后顺序；XLSX 工作簿关系、共享字符串、两张表、缓存/无缓存公式；PPTX 特意先写 slide10 再写 slide2，含组形状/表格。另有各格式的空文档。
- PDF：带完整 xref/页树的真实 PDF。sample 含 Helvetica 文本与自编 ToUnicode CMap 的中文/emoji；scanned 含本地 1×1 图片且无文本层；empty 是空白页；encrypted 使用 PDF Standard R2/RC4 合成口令，仅用于拒绝加密文件测试；broken 是损坏文件。
- 安全测试用 fflate 在这些合成文件上构造 ZIP 路径/大小/CRC/标志/XML 等变体；不执行其中内容。Office CFB 加密测试仅为格式签名探针，不冒称完成加密 Office 解密或所有加密变体测试。

夹具不追求复杂排版、真正 VBA 字节码或扫描 OCR。格式输出差异和不支持项见 `docs/S04_VALIDATION.md`。

`.gitattributes` 保留 PDF/Office 原字节及 TXT/CSV 的 BOM/CRLF 用例，不经 Git 换行转换。PDF xref 固定宽度记录中的尾空格属于文件格式，不应按源码格式化。
