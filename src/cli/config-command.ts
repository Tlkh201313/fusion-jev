import { dirname, isAbsolute } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { UsageError } from '../errors.js';

/** Loaded lazily: `fusion-jev run` and `fusion-jev evidence` never need them. */
export interface ConfigModules {
  privateConfig: typeof import('../private-config.js');
  configPath: typeof import('../config-path.js');
}

export async function loadConfigModules(): Promise<ConfigModules> {
  const [privateConfig, configPath] = await Promise.all([import('../private-config.js'), import('../config-path.js')]);
  return { privateConfig, configPath };
}

export const userConfigPath = (modules: ConfigModules): string => modules.configPath.resolveUserConfigPath();

/** The env file saved with `config env-file`, if any. */
function savedEnvFile(modules: ConfigModules): string | undefined {
  const path = userConfigPath(modules);
  if (!existsSync(path)) return undefined;
  try {
    modules.privateConfig.assertPrivatePath(dirname(path), true);
    modules.privateConfig.assertPrivatePath(path, false);
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof data !== 'object' ||
      data === null ||
      !('envFile' in data) ||
      typeof data.envFile !== 'string' ||
      !isAbsolute(data.envFile)
    )
      throw new Error();
    return data.envFile;
  } catch {
    throw new Error('Saved Fusion env-file setting is invalid; run fusion-jev config env-file --clear');
  }
}

/** `config env-file <ABSOLUTE_PATH | --clear>` */
export function configureEnvFile(value: string | undefined, modules: ConfigModules): void {
  if (!value) throw new UsageError('Provide an absolute env-file path or --clear');
  const configPath = userConfigPath(modules);
  if (value === '--clear') {
    rmSync(configPath, { force: true });
    process.stdout.write('Saved Fusion env-file path cleared.\n');
    return;
  }
  if (!isAbsolute(value)) throw new UsageError('Env file path must be absolute');
  let resolved: string;
  try {
    resolved = modules.privateConfig.assertPrivatePath(value, false);
  } catch {
    throw new Error('Configured env file is unavailable or invalid');
  }
  modules.privateConfig.preparePrivateDirectory(dirname(configPath));
  if (existsSync(configPath)) modules.privateConfig.assertPrivatePath(configPath, false);
  writeFileSync(configPath, JSON.stringify({ envFile: resolved }) + '\n', { mode: 0o600 });
  process.stdout.write('Saved Fusion env-file path for future commands.\n');
}

/** Loads the provider env file chosen by --provider-env, FUSION_ENV_FILE, or the saved setting. */
export function loadProviderEnvFile(providerEnv: string | undefined, modules: ConfigModules): void {
  if (providerEnv === '') throw new UsageError('Env file path must be absolute');
  const envFile =
    providerEnv ?? (process.env.FUSION_ENV_FILE !== undefined ? process.env.FUSION_ENV_FILE : savedEnvFile(modules));
  if (!envFile) return;
  if (!isAbsolute(envFile)) throw new UsageError('Env file path must be absolute');
  try {
    process.loadEnvFile(modules.privateConfig.assertPrivatePath(envFile, false));
  } catch {
    throw new Error('Configured env file is unavailable or invalid');
  }
}
