import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPrivatePath, preparePrivateDirectory } from './private-config.js';

function regularFile(path: string): string {
  if (!isAbsolute(path)) throw new Error('Env file path must be absolute');
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error();
    return assertPrivatePath(path, false);
  } catch { throw new Error('Configured env file is unavailable or invalid'); }
}

function exclusiveFile(path: string, content: string): boolean {
  if (existsSync(path)) {
    assertPrivatePath(path, false);
    return false;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content);
    closeSync(descriptor); descriptor = undefined;
    // Publish an entirely written file without replacing any existing target.
    linkSync(temporary, path);
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
}

export function prepareSetup(options: { configDir: string; envFile?: string; executable: string; cliPath: string; dryRun?: boolean }): { envFile: string; created: boolean; instructions: string } {
  if (!isAbsolute(options.configDir) || !isAbsolute(options.executable) || !isAbsolute(options.cliPath)) throw new Error('Setup paths must be absolute');
  let envFile = options.envFile ? regularFile(options.envFile) : join(options.configDir, 'provider.env');
  let created = false;
  if (!options.dryRun) {
    const canonicalDir = preparePrivateDirectory(options.configDir);
    if (!options.envFile) envFile = join(canonicalDir, 'provider.env');
    created = options.envFile ? false : exclusiveFile(envFile, '# Private provider configuration. Never commit this file.\nTYPESAFE_API_KEY=\nFUSION_FALLBACK=host\n');
    const settings = join(canonicalDir, 'config.json');
    if (existsSync(settings)) {
      assertPrivatePath(settings, false);
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(settings, 'utf8')); } catch { throw new Error('Saved setup config is invalid'); }
      if (!saved || typeof saved !== 'object' || !('envFile' in saved) || saved.envFile !== envFile)
        throw new Error('A different env-file setting exists; use fusion-jev config env-file ABSOLUTE_PATH to change it explicitly');
    } else exclusiveFile(settings, JSON.stringify({ envFile }) + '\n');
  }
  const node = quote(options.executable), cli = quote(options.cliPath), envArg = quote(`--provider-env=${envFile}`);
  const doctor = `${process.platform === 'win32' ? '& ' : ''}${node} ${cli} doctor stdio ${envArg}`;
  const commands = `codex mcp add fusion-jev -- ${node} ${cli} stdio ${envArg}\nclaude mcp add --transport stdio --scope user fusion-jev -- ${node} ${cli} stdio ${envArg}`;
  return { envFile, created, instructions: `${options.dryRun ? 'Dry run: no files written.' : created ? 'Created a private provider template.' : 'Kept the existing provider file.'}\nEdit this private file to enable optional Jev choices:\n${envFile}\nSet TYPESAFE_API_KEY to your official TypeSafe key. Deterministic local tools work without it.\nCheck local configuration (no provider call):\n${doctor}\nConnect one host with the command for your shell:\n${commands}\nHost configurations were not changed. Restart the MCP connection after adding it.\n` };
}
