import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export function evidenceStorageDir(): string {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA :
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  if (!base || !isAbsolute(base)) throw new Error('Fusion evidence cache directory must be absolute');
  return join(base, 'fusion-jev-mcp', 'evidence');
}
