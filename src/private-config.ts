import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';

function windowsPrivacy(path: string, directory: boolean, protect: boolean, parent = false): void {
  const script = `
$ErrorActionPreference = 'Stop'
$target = $env:FUSION_PRIVATE_PATH
$directory = $env:FUSION_PRIVATE_DIRECTORY -eq '1'
$acl = if ($directory) { [System.IO.Directory]::GetAccessControl($target) } else { [System.IO.File]::GetAccessControl($target) }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:FUSION_PRIVATE_PROTECT -eq '1') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) | Out-Null }
  $inheritance = if ($directory) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  if ($directory) { [System.IO.Directory]::SetAccessControl($target, $acl) } else { [System.IO.File]::SetAccessControl($target, $acl) }
}
$allowed = @($current.Value, 'S-1-5-18', 'S-1-5-32-544')
$parent = $env:FUSION_PRIVATE_PARENT -eq '1'
# Reject rights that permit creation, modification, deletion or ACL takeover.
$writeRights = 2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288
$selfAllowed = $false
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($allowed -notcontains $sid -and (-not $parent -or ([int]$rule.FileSystemRights -band $writeRights) -ne 0)) { throw "Shared access ($sid rights $([int]$rule.FileSystemRights))" }
  if ($sid -eq $current.Value) { $selfAllowed = $true }
}
if (-not $selfAllowed -and -not $parent) { throw 'Current user lacks access' }
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
# Elevated Windows administrators create objects owned by the Administrators group rather than their own SID.
# That group is already an accepted principal in the ACL, so accept it as owner only for an administrator caller.
$administrator = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$ownerOk = if ($parent) { $allowed -contains $owner } else { $owner -eq $current.Value -or ($administrator -and $owner -eq 'S-1-5-32-544') }
if (-not $ownerOk) { throw "Wrong owner ($owner)" }
[Console]::Out.WriteLine('PRIVATE')
`;
  const powershell=join(process.env.SystemRoot ?? 'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  if (!isAbsolute(powershell)) throw new Error('Windows system executable path must be absolute');
  const result = spawnSync(powershell, ['-NoProfile','-NonInteractive','-Command',script], { windowsHide:true,encoding:'utf8',timeout:10_000,
    env:{...process.env,FUSION_PRIVATE_PATH:path,FUSION_PRIVATE_DIRECTORY:directory?'1':'0',FUSION_PRIVATE_PROTECT:protect?'1':'0',FUSION_PRIVATE_PARENT:parent?'1':'0'} });
  if (result.status!==0 || result.stdout.trim()!=='PRIVATE') {
    const reason=String(result.stderr ?? '').split(/\r?\n/, 1)[0]?.trim();
    throw new Error('Configuration path permissions must be private to the current user'+(reason?` (${reason})`:''));
  }
}

function assertSafeParent(path: string): void {
  const parent=dirname(path), info=lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Configuration parent must be a real directory');
  if (process.platform==='win32') windowsPrivacy(parent,true,false,true);
  else {
    const writable=(info.mode & 0o022)!==0, sticky=(info.mode & 0o1000)!==0;
    if (process.getuid && info.uid!==process.getuid() && info.uid!==0 || writable && !sticky)
      throw new Error('Configuration parent must not allow replacement by other users');
  }
}

export function assertPrivatePath(path: string, directory: boolean): string {
  if (!isAbsolute(path)) throw new Error('Configuration path must be absolute');
  let info;
  try { info=lstatSync(path); } catch { throw new Error('Configuration path is unavailable'); }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Configuration path must be a regular file or real directory');
  assertSafeParent(path);
  if (process.platform==='win32') windowsPrivacy(path,directory,false);
  else if ((info.mode & 0o077)!==0 || process.getuid && info.uid!==process.getuid()) throw new Error('Configuration path permissions must be private to the current user');
  return realpathSync(path);
}

export function preparePrivateDirectory(path: string): string {
  const existed=existsSync(path);
  if (existed) return assertPrivatePath(path,true);
  // Create an absent base first, then check its immediate ACL before creating secrets.
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  assertSafeParent(path);
  mkdirSync(path,{recursive:true,mode:0o700});
  if (process.platform==='win32') windowsPrivacy(path,true,true);
  return assertPrivatePath(path,true);
}
