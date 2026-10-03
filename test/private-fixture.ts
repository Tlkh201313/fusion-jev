import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Protect only a fresh empty test directory, never an existing profile/config path.
export function privateFixtureHome(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $path=$env:FUSION_TEST_PRIVATE_DIR; $acl=[System.IO.Directory]::GetAccessControl($path); $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleAll($rule)|Out-Null}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)); [System.IO.Directory]::SetAccessControl($path,$acl)`;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, FUSION_TEST_PRIVATE_DIR: directory },
    });
    if (result.status !== 0) {
      rmdirSync(directory);
      throw new Error('Unable to create private test fixture');
    }
  }
  return directory;
}
