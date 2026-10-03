import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { assertWindowsPrivacy } from './acl.js';

function assertSafeParent(path: string): void {
  const parent=dirname(path), info=lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Configuration parent must be a real directory');
  if (process.platform==='win32') assertWindowsPrivacy(parent,true,false,true);
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
  if (process.platform==='win32') assertWindowsPrivacy(path,directory,false);
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
  if (process.platform==='win32') assertWindowsPrivacy(path,true,true);
  return assertPrivatePath(path,true);
}
