import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SnapshotStore, PublishedCommitError } from '../../apps/server/src/storage/snapshot.js';
import { inspectStorage, recoverStorage } from '../../apps/server/src/storage/recovery.js';
import { ModelConfigStore } from '../../apps/server/src/models/config.js';
import { temporaryDirectory } from '../helpers/temporary-directory.js';
import { textProfile, embeddingProfile, bindings } from '../helpers/model-profiles.js';
import { indexFixture } from '../helpers/indexed-state.js';

it('restores private model versions and cached state from a Unicode/quote path', async () => {
  const directory = await temporaryDirectory(); const root = join(directory.path, "平台 ' test");
  let storage = await SnapshotStore.open(root); let config = await ModelConfigStore.open(root, storage);
  try {
    await config.save({ expectedRevision: 0, profiles: [textProfile('http://127.0.0.1:7777/v1'), embeddingProfile('http://127.0.0.1:7778/v1')], bindings: { ...bindings, rerank: null } });
    await config.save({ expectedRevision: 1, profiles: [textProfile('http://127.0.0.1:7777/v1'), embeddingProfile('http://127.0.0.1:7778/v1')], bindings: { ...bindings, rerank: null } });
    // Keep this fixture independent of model space activation.
    await storage.transact(draft => { draft.kv.caches.set('平台', 'persistent'); });
    const before = storage.capture().export();
    await config.close(); await storage.close();
    storage = await SnapshotStore.open(root); config = await ModelConfigStore.open(root, storage);
    expect(storage.capture().export()).toEqual(before);
    expect(config.capture().profiles[0]?.apiKey).toBe('synthetic-s03-secret');
    expect(config.public().profiles[0]?.hasApiKey).toBe(true);
    expect(JSON.stringify(config.public())).not.toContain('synthetic-s03-secret');
    if (process.platform === 'win32') {
      const target = join(root, 'config').replaceAll("'", "''");
      const script = `$ErrorActionPreference='Stop'; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $r='${target}'; $items=@((Get-Item -LiteralPath $r))+@(Get-ChildItem -LiteralPath $r -Force -Recurse); foreach($i in $items){$a=Get-Acl -LiteralPath $i.FullName; if(-not $a.AreAccessRulesProtected){throw 'Inherited ACL'}; $rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if($rules.Count -eq 0){throw 'Empty ACL'}; foreach($rule in $rules){if($rule.IdentityReference.Value -ne $u -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow'){throw 'Unexpected ACL'}}}; Write-Output 'private-acls-verified'`;
      const { stdout } = await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30_000, windowsHide: true });
      expect(stdout.trim()).toBe('private-acls-verified');
    }
  } finally { await config.close(); await storage.close(); await directory.cleanup(); }
}, 120_000);

it('validates a generation, refuses live recovery and restores a corrupt CURRENT explicitly', async () => {
  const directory = await temporaryDirectory(); const storage = await SnapshotStore.open(directory.path);
  try {
    await storage.transact(indexFixture); const generation = storage.capture().generation;
    await expect(inspectStorage(directory.path)).rejects.toThrow('STORAGE_LOCKED');
    await expect(recoverStorage(directory.path, generation, true)).rejects.toThrow('STORAGE_LOCKED');
    await storage.close();
    const current = join(directory.path, 'workspace/default/CURRENT');
    const pointer = await readFile(current, 'utf8'); await writeFile(current, 'broken-current');
    await expect(SnapshotStore.open(directory.path)).rejects.toThrow();
    await expect(recoverStorage(directory.path, generation, false)).rejects.toThrow('confirm-data-loss');
    expect((await inspectStorage(directory.path, generation)).validated).toBe(true);
    await recoverStorage(directory.path, generation, true);
    expect(await readFile(current, 'utf8')).toBe(pointer);
    expect((await inspectStorage(directory.path)).nodeCount).toBe(2);
  } finally { await storage.close(); await directory.cleanup(); }
});

it('fences publication errors without claiming Windows directory durability', async () => {
  const directory = await temporaryDirectory(); let armed = false;
  const storage = await SnapshotStore.open(directory.path, { hook: async point => { if (armed && point === 'after-current-sync') throw new Error('injected'); } });
  try {
    armed = true;
    const result = await storage.transact(draft => { draft.kv.caches.set('commit', 'published'); }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(PublishedCommitError);
    expect(result).toMatchObject({ published: true, durabilityConfirmed: process.platform !== 'win32' });
    expect(storage.healthy).toBe(false);
    await expect(storage.transact(() => {})).rejects.toThrow('fenced');
    await storage.close();
    const restored = await SnapshotStore.open(directory.path);
    try { expect(restored.capture().getKV('caches', 'commit')).toBe('published'); } finally { await restored.close(); }
  } finally { await storage.close(); await directory.cleanup(); }
});

it('rejects actual rename failures and preserves the last generation', async () => {
  const directory = await temporaryDirectory(); const storage = await SnapshotStore.open(directory.path);
  const current = join(directory.path, 'workspace/default/CURRENT'); const saved = `${current}.saved`;
  try {
    const generation = storage.capture().generation;
    await rename(current, saved); await mkdir(current);
    await expect(storage.transact(draft => { draft.kv.caches.set('bad', true); })).rejects.toThrow();
    expect(storage.capture().generation).toBe(generation);
    await rm(current, { recursive: true }); await rename(saved, current);
    await storage.transact(draft => { draft.kv.caches.set('good', true); });
    expect(storage.capture().getKV('caches', 'bad')).toBeUndefined();
    expect(storage.capture().getKV('caches', 'good')).toBe(true);
  } finally { await storage.close(); await directory.cleanup(); }
});
