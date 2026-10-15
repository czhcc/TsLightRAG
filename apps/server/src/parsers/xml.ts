import { SaxesParser } from 'saxes';
import { fail, utf8 } from './common.js';
import type { Limits } from './common.js';
export interface XmlNode { name: string; attrs: Record<string, string>; children: (XmlNode | string)[] }
export function xml(bytes: Uint8Array, limits: Limits): XmlNode {
  const source = utf8(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) fail('UNSAFE_XML', '不允许 XML DTD 或实体声明');
  const parser = new SaxesParser({ xmlns: true }); const stack: XmlNode[] = []; let root: XmlNode | undefined; let nodes = 0;
  parser.on('opentag', (tag) => {
    if (++nodes > limits.nodes || stack.length >= limits.depth) fail('PARSER_LIMIT', 'XML 结构超过解析上限');
    const attrs = Object.create(null) as Record<string, string>;
    for (const value of Object.values(tag.attributes)) {
      // Preserve qualified attrs as well as local names (e.g. r:id).
      attrs[value.name] = value.value; if (!(value.local in attrs)) attrs[value.local] = value.value;
    }
    const node: XmlNode = { name: tag.local, attrs, children: [] };
    if (stack.length) stack.at(-1)!.children.push(node); else root = node;
    stack.push(node);
  });
  const addText = (text: string) => { if (++nodes > limits.nodes) fail('PARSER_LIMIT', 'XML 结构超过解析上限'); stack.at(-1)?.children.push(text); };
  parser.on('text', addText); parser.on('cdata', addText); parser.on('closetag', () => { stack.pop(); });
  parser.on('error', () => { fail('INVALID_XML', 'Office XML 格式不合法'); });
  try { parser.write(source).close(); } catch (e) { if (e instanceof Error && 'code' in e) throw e; fail('INVALID_XML', 'Office XML 格式不合法'); }
  if (!root) fail('INVALID_XML', 'Office XML 缺少根节点'); return root;
}
export function children(node: XmlNode, name?: string) { return node.children.filter((n): n is XmlNode => typeof n !== 'string' && (!name || n.name === name)); }
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const child of children(node)) { if (child.name === name) result.push(child); result.push(...descendants(child, name)); }
  return result;
}
export function xmlText(node: XmlNode): string { return node.children.map((n) => typeof n === 'string' ? n : xmlText(n)).join(''); }
export function runText(node: XmlNode): string {
  if (node.name === 't') return xmlText(node);
  if (node.name === 'tab') return '\t'; if (node.name === 'br' || node.name === 'cr') return '\n';
  if (['instrText', 'del', 'object', 'drawing'].includes(node.name)) return '';
  return children(node).map(runText).join('');
}
