import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync, strToU8 } from 'fflate';
export async function documentFixture(name: string) { return readFile(new URL(`../fixtures/documents/${name}`, import.meta.url)); }
export async function editOffice(name: 'docx' | 'xlsx' | 'pptx', change: (files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(await documentFixture(`sample.${name}`)); change(files);
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') }));
}
export const xmlBytes = strToU8;
