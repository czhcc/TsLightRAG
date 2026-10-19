import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStartup } from './cli.js';
import { temporaryDirectory } from '../../../tests/helpers/temporary-directory.js';

describe('CLI configuration', () => {
  it('resolves defaults from repository root, independent of cwd', async () => {
    expect(await parseStartup([], '/workspace/project')).toEqual({ host: '127.0.0.1', port: 9621, dataDir: '/workspace/project/data' });
  });
  it('uses config then explicit CLI overrides and preserves existing config', async () => {
    const directory = await temporaryDirectory();
    try {
      await writeFile(join(directory.path, 'startup.json'), JSON.stringify({ host: '::1', port: 9876, dataDir: 'existing-data' }));
      expect(await parseStartup(['--config', 'startup.json'], directory.path)).toEqual({ host: '::1', port: 9876, dataDir: join(directory.path, 'existing-data') });
      expect(await parseStartup(['--config', 'startup.json', '--port', '0', '--host', '127.0.0.1', '--data-dir', 'new-data'], directory.path)).toEqual({ host: '127.0.0.1', port: 0, dataDir: join(directory.path, 'new-data') });
      await writeFile(join(directory.path, 'network.json'), JSON.stringify({ host: '0.0.0.0' }));
      expect((await parseStartup(['--config', 'network.json'], directory.path))?.host).toBe('0.0.0.0');
    } finally { await directory.cleanup(); }
  });
  it.each([
    ['--host', '999.0.0.1'], ['--host', 'example.com'], ['--port', '-1'], ['--port', '65536'],
    ['--port', '1.5'], ['--port', ''], ['--port', '123abc'], ['--unknown'], ['positional'],
  ])('rejects invalid arguments %j', async (...args) => { await expect(parseStartup(args)).rejects.toThrow(); });
  it.each(['0.0.0.0', '192.168.1.20', '::', '2001:db8::20'])('supports explicit network listening at %s', async host => {
    expect((await parseStartup(['--host', host]))?.host).toBe(host);
  });
  it('sanitizes malformed or missing config and disallows unknown fields', async () => {
    const directory = await temporaryDirectory();
    try {
      await writeFile(join(directory.path, 'bad.json'), '{"apiKey":"fixture-secret"');
      await expect(parseStartup(['--config', 'bad.json'], directory.path)).rejects.toThrow('启动配置无法读取或格式不合法');
      await expect(parseStartup(['--config', 'missing.json'], directory.path)).rejects.toThrow('启动配置无法读取或格式不合法');
      await writeFile(join(directory.path, 'unknown.json'), '{"apiKey":"fixture-secret"}');
      await expect(parseStartup(['--config', 'unknown.json'], directory.path)).rejects.toThrow('启动配置无法读取或格式不合法');
    } finally { await directory.cleanup(); }
  });
  it('supports help without starting the application', async () => { expect(await parseStartup(['--help'])).toBeNull(); });
});
