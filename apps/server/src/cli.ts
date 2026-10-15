import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { repositoryRoot } from './paths.js';

const startupSchema = z.strictObject({
  host: z.enum(['127.0.0.1', '::1']),
  port: z.number().int().min(0).max(65_535),
  dataDir: z.string().min(1),
});
const fileSchema = z.strictObject({
  host: z.enum(['127.0.0.1', '::1']).optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  dataDir: z.string().min(1).optional(),
});
export type StartupOptions = z.infer<typeof startupSchema>;

export const help = `TsLightRAG (S05)\nUsage: npm start -- [options]\n\n--host <127.0.0.1|::1>  Loopback only (default 127.0.0.1)\n--port <0..65535>        Default 9621; 0 selects a free port\n--data-dir <path>       Persistent local storage (default ./data)\n--config <file.json>    Optional startup JSON (host, port, dataDir)\n--help                  Show help\n\nRelative paths resolve from the repository root. Models are configured in the WebUI and persisted in data-dir/config/app.json.\n`;

export async function parseStartup(args: string[], root = repositoryRoot): Promise<StartupOptions | null> {
  const { values } = parseArgs({
    args, strict: true, allowPositionals: false,
    options: {
      host: { type: 'string' }, port: { type: 'string' },
      'data-dir': { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean' },
    },
  });
  if (values.help) return null;
  let file: z.infer<typeof fileSchema> = {};
  if (values.config !== undefined) {
    // Do not echo a potentially secret-bearing file or parsing error to stderr.
    try {
      file = fileSchema.parse(JSON.parse(await readFile(resolve(root, values.config), 'utf8')));
    } catch {
      throw new Error('启动配置无法读取或格式不合法；只允许 host、port、dataDir 字段');
    }
  }
  if (values.port !== undefined && !/^\d+$/.test(values.port)) {
    throw new Error('端口必须是 0 到 65535 的整数');
  }
  const result = startupSchema.safeParse({
    host: values.host ?? file.host ?? '127.0.0.1',
    port: values.port === undefined ? (file.port ?? 9621) : Number(values.port),
    dataDir: values['data-dir'] ?? file.dataDir ?? './data',
  });
  if (!result.success) throw new Error('启动参数不合法：仅允许 loopback 地址和 0 到 65535 的整数端口');
  return { ...result.data, dataDir: resolve(root, result.data.dataDir) };
}
