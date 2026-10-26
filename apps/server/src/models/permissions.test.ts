import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { protectConfigurationDirectory } from './permissions.js';

it.skipIf(process.platform !== 'win32')('reapplies private ACLs on restart after config files have been created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tslightrag-acl-'));
  const config = join(root, "config ' restart");
  try {
    await mkdir(config);
    await protectConfigurationDirectory(config);
    await mkdir(join(config, 'versions'));
    await writeFile(join(config, 'app.json'), '{}');
    await writeFile(join(config, 'versions', '0.json'), '{}');
    await protectConfigurationDirectory(config);
    await protectConfigurationDirectory(config);
    const script = `$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root='${config.replaceAll("'", "''")}'
$items=@((Get-Item -LiteralPath $root))+@(Get-ChildItem -LiteralPath $root -Recurse -Force)
foreach($item in $items){
  $acl=Get-Acl -LiteralPath $item.FullName
  if(-not $acl.AreAccessRulesProtected){throw 'Inherited ACL'}
  if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Unexpected owner'}
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  if($rules.Count -ne 1){throw 'Unexpected rule count'}
  if($rules[0].IdentityReference.Value -ne $sid -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl'){throw 'Unexpected access'}
}
Write-Output 'private-acls-verified'`;
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await promisify(execFile)(executable,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000 });
    expect(stdout.trim()).toBe('private-acls-verified');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
