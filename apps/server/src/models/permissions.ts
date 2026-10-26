import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

// Windows has ACLs rather than POSIX mode bits. Use the built-in, noninteractive
// PowerShell/.NET API to apply a protected current-account DACL. No profile,
// network, external module, interpolated shell argument, or secret is involved.
export async function protectConfigurationDirectory(path: string) {
  if (process.platform !== 'win32') { await chmod(path, 0o700); return; }
  const literal = path.replaceAll("'", "''");
  const script = `$ErrorActionPreference = 'Stop'
$root = '${literal}'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
function Protect-Item([string]$target) {
  $item = Get-Item -LiteralPath $target -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Configuration reparse point refused' }
  if ($item.PSIsContainer) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  $owner = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $user.Value) {
    $acl.SetOwner($user)
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
  } else {
    # Persist only the DACL when ownership is already correct. Reapplying
    # Set-Acl may otherwise request the unrelated SeSecurityPrivilege.
    $item.SetAccessControl($acl)
  }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { Protect-Item $child.FullName }
  }
}
Protect-Item $root`;
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await promisify(execFile)(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error('Windows configuration ACL protection failed; refusing to load credentials');
  }
}
