import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function resolveUserConfigPath(env: Record<string,string|undefined> = process.env, platform: NodeJS.Platform = process.platform, userHome: string = homedir()): string {
  const directory = env.FUSION_CONFIG_HOME
    ? join(env.FUSION_CONFIG_HOME,'fusion-jev-mcp')
    : platform==='win32' ? join(userHome,'.fusion-jev-mcp')
    : join(env.XDG_CONFIG_HOME ?? join(userHome,'.config'),'fusion-jev-mcp');
  if(!isAbsolute(directory))throw new Error('Fusion config directory must be absolute');
  return join(directory,'config.json');
}
