#!/usr/bin/env node
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from './config.js';
import { FusionRouter } from './router.js';
import { JevProvider } from './providers/jev.js';
import { mcpToolNames, startHttpServer, startStdioServer, validateHttpConfig } from './mcp.js';
import { WorkspaceError, WorkspaceService } from './workspace.js';
import { EvidenceStore } from './evidence.js';
import { renderChannelSummary, summarizeChannel } from './command-summary.js';
import { runCommand } from './run.js';
import { prepareSetup } from './setup.js';
import { fileURLToPath } from 'node:url';
import { assertPrivatePath, preparePrivateDirectory } from './private-config.js';
import { resolveUserConfigPath } from './config-path.js';

const help = `Fusion Jev: local coding evidence and optional guarded choices

Usage: fusion-jev [setup | stdio | http | doctor [stdio|http] | config doctor | --help] [--provider-env=ABSOLUTE_PATH]
       fusion-jev config env-file <ABSOLUTE_PATH | --clear>
        fusion-jev run [--raw] [--timeout-ms=N] [--max-capture-bytes=N] [--cwd=ABSOLUTE_PATH] -- program argv...
        fusion-jev evidence ID [--start-byte=N] [--max-bytes=N] [--raw]

setup          Create private provider template and emit host connection commands.
stdio          Run local MCP over stdin/stdout (default).
http           Run Streamable HTTP at /mcp and health at /healthz.
doctor         Check configuration locally; does not call providers.
config doctor  Alias for doctor.

Environment: TYPESAFE_API_KEY for Jev; FUSION_FALLBACK=host.
Use --provider-env=ABSOLUTE_PATH, FUSION_ENV_FILE, or a saved per-user path to load a trusted env file.
Local stdio exposes named read-only file/search/Git tools, plus Jev routing.
Pass an approved root for the active local project, or set FUSION_WORKSPACE_ROOT as a default.
Additional local roots must be listed in FUSION_WORKSPACE_ALLOWED_ROOTS, separated
by the platform path delimiter; roots outside that allowlist are rejected.
HTTP exposes workspace tools only when FUSION_HTTP_ENABLE_WORKSPACE=true and
FUSION_WORKSPACE_ROOT points to a server-side project. Otherwise it is a
general Jev decision service and does not expose repository files.
Uncertain work returns to the current Codex or Claude host session.
Remote HTTP requires FUSION_PUBLIC_URL and complete external OAuth settings.
Source-checkout npm scripts load .env; the global fusion-jev command does not load it implicitly.
Provider keys are never returned to clients. See README.md and .env.example.
`;

function evidenceStore(): EvidenceStore {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA :
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  if (!base || !isAbsolute(base)) throw new Error('Fusion evidence cache directory must be absolute');
  return new EvidenceStore({ storageDir: join(base, 'fusion-jev-mcp', 'evidence') });
}

function positiveInteger(value: string, label: string, minimum = 1): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`Invalid ${label}`);
  return parsed;
}

async function runCli(args: string[]): Promise<void> {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) throw new Error('Usage: fusion-jev run [options] -- program argv...');
  let raw = false;
  let timeoutMs: number | undefined;
  let maxCaptureBytes: number | undefined;
  let cwd: string | undefined;
  for (const option of args.slice(0, separator)) {
    if (option === '--raw') raw = true;
    else if (option.startsWith('--timeout-ms=')) timeoutMs = positiveInteger(option.slice(13), 'timeout-ms');
    else if (option.startsWith('--max-capture-bytes=')) maxCaptureBytes = positiveInteger(option.slice(20), 'max-capture-bytes');
    else if (option.startsWith('--cwd=')) {
      cwd = option.slice(6);
      if (!isAbsolute(cwd)) throw new Error('Command cwd must be absolute');
    } else throw new Error(`Unknown Fusion run option: ${option}`);
  }
  const argv = args.slice(separator + 1) as [string, ...string[]];
  if (!argv[0]) throw new Error('Usage: fusion-jev run [options] -- program argv...');
  // Raw output already reaches the host byte-for-byte and publishes no receipts.
  // Do not pay for persistent evidence initialization or write unreachable captures.
  const store = raw ? new EvidenceStore() : evidenceStore();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await runCommand({ argv, cwd, timeoutMs, maxCaptureBytes, raw }, store, controller.signal);
    if (!raw) {
      const stdout = await summarizeChannel(store, result.stdout);
      const stderr = await summarizeChannel(store, result.stderr);
      process.stdout.write(`termination=${result.termination} exitCode=${result.exitCode ?? 'null'} stdout=${result.stdout.id} stdoutTruncated=${result.stdout.truncated} stdoutRedacted=${result.stdout.redacted} stdoutStoredBytes=${result.stdout.storedBytes} stdoutOriginalBytes=${result.stdout.originalBytes ?? 'null'} stderr=${result.stderr.id} stderrTruncated=${result.stderr.truncated} stderrRedacted=${result.stderr.redacted} stderrStoredBytes=${result.stderr.storedBytes} stderrOriginalBytes=${result.stderr.originalBytes ?? 'null'} durationMs=${Math.round(result.durationMs)} cleanupFailed=${Boolean(result.cleanupFailed)}\n`);
      process.stdout.write(renderChannelSummary(stdout));
      process.stderr.write(renderChannelSummary(stderr));
      process.stdout.write(`recoverStdout=fusion-jev evidence ${result.stdout.id} --raw\nrecoverStderr=fusion-jev evidence ${result.stderr.id} --raw\n`);
      process.stdout.write(`recoverStdoutArgv=${JSON.stringify([process.execPath, fileURLToPath(import.meta.url), 'evidence', result.stdout.id, '--raw'])}\nrecoverStderrArgv=${JSON.stringify([process.execPath, fileURLToPath(import.meta.url), 'evidence', result.stderr.id, '--raw'])}\n`);
    }
    process.exitCode = result.termination === 'exit' ? result.exitCode ?? 1 :
      result.termination === 'timeout' ? 124 : result.termination === 'cancelled' ? 130 :
      result.termination === 'spawn_error' ? 127 : 128;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

async function evidenceCli(args: string[]): Promise<void> {
  if (!args[0] || !/^[0-9a-f-]{36}$/.test(args[0])) throw new Error('Usage: fusion-jev evidence ID [--start-byte=N] [--max-bytes=N] [--raw]');
  let raw = false;
  let startByte = 0;
  let maxBytes = 16 * 1024;
  for (const option of args.slice(1)) {
    if (option === '--raw') raw = true;
    else if (option.startsWith('--start-byte=')) startByte = positiveInteger(option.slice(13), 'start-byte', 0);
    else if (option.startsWith('--max-bytes=')) maxBytes = positiveInteger(option.slice(12), 'max-bytes');
    else throw new Error(`Unknown Fusion evidence option: ${option}`);
  }
  if (maxBytes > 64 * 1024) throw new Error('max-bytes must be at most 65536');
  const store = evidenceStore();
  const page = await store.expand({ id: args[0], startByte, maxBytes });
  if (page.status !== 'ok' && page.status !== 'stale') throw new Error(`Evidence ${page.status}`);
  if (raw) {
    process.stdout.write(Buffer.from(page.dataBase64, 'base64'));
    let nextByte = page.nextByte;
    while (nextByte !== null) {
      const next = await store.expand({ id: args[0], startByte: nextByte, maxBytes });
      if (next.status !== 'ok' && next.status !== 'stale') throw new Error(`Evidence ${next.status}`);
      process.stdout.write(Buffer.from(next.dataBase64, 'base64'));
      nextByte = next.nextByte;
    }
  } else process.stdout.write(JSON.stringify(page) + '\n');
}

function userConfigPath(): string {
  return resolveUserConfigPath();
}

function configuredWorkspaceRoots(): { defaultRoot: string; allowedRoots: Set<string> } {
  const defaultRoot = process.env.FUSION_WORKSPACE_ROOT || process.cwd();
  const requestedRoots = [defaultRoot, ...(process.env.FUSION_WORKSPACE_ALLOWED_ROOTS ?? '').split(delimiter).map(root => root.trim()).filter(Boolean)];
  const allowedRoots = new Set(requestedRoots.map(root => {
    try {
      const canonical = realpathSync.native(root);
      if (!statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    } catch { throw new Error('A configured workspace root is unavailable or is not a directory'); }
  }));
  return { defaultRoot, allowedRoots };
}

function savedEnvFile(): string | undefined {
  const path = userConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    assertPrivatePath(dirname(path), true);
    assertPrivatePath(path, false);
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof data !== 'object' || data === null || !('envFile' in data) ||
      typeof data.envFile !== 'string' || !isAbsolute(data.envFile)) throw new Error();
    return data.envFile;
  } catch { throw new Error('Saved Fusion env-file setting is invalid; run fusion-jev config env-file --clear'); }
}

function configureEnvFile(value: string | undefined): void {
  if (!value) throw new Error('Provide an absolute env-file path or --clear');
  const configPath = userConfigPath();
  if (value === '--clear') {
    rmSync(configPath, { force: true });
    process.stdout.write('Saved Fusion env-file path cleared.\n');
    return;
  }
  if (!isAbsolute(value)) throw new Error('Env file path must be absolute');
  let resolved: string;
  try {
    resolved = assertPrivatePath(value, false);
  } catch { throw new Error('Configured env file is unavailable or invalid'); }
  preparePrivateDirectory(dirname(configPath));
  if (existsSync(configPath)) assertPrivatePath(configPath, false);
  writeFileSync(configPath, JSON.stringify({ envFile: resolved }) + '\n', { mode: 0o600 });
  process.stdout.write('Saved Fusion env-file path for future commands.\n');
}

async function main(): Promise<void> {
  if (process.argv[2] === 'run') { await runCli(process.argv.slice(3)); return; }
  if (process.argv[2] === 'evidence') { await evidenceCli(process.argv.slice(3)); return; }
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--provider-env='));
  const envFileArgs = process.argv.slice(2).filter(arg => arg.startsWith('--provider-env='));
  if (envFileArgs.length > 1) throw new Error('Specify --env-file only once');
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') { process.stdout.write(help); return; }
  if (args[0] === 'setup') {
    if (args.slice(1).some(arg => arg !== '--dry-run') || args.filter(arg => arg === '--dry-run').length > 1)
      throw new Error('Usage: fusion-jev setup [--dry-run] [--provider-env=ABSOLUTE_PATH]');
    const result = prepareSetup({ configDir: dirname(userConfigPath()), envFile: envFileArgs[0]?.slice('--provider-env='.length),
      executable: process.execPath, cliPath: fileURLToPath(new URL('../dist/cli.js', import.meta.url)), dryRun: args.includes('--dry-run') });
    process.stdout.write(result.instructions);
    return;
  }
  if (args[0] === 'config' && args[1] === 'env-file') {
    if (args.length !== 3 || envFileArgs.length) throw new Error('Usage: fusion-jev config env-file <ABSOLUTE_PATH | --clear>');
    configureEnvFile(args[2]);
    return;
  }
  if (envFileArgs.length && envFileArgs[0] === '--provider-env=') throw new Error('Env file path must be absolute');
  const envFile = envFileArgs[0]?.slice('--provider-env='.length) ??
    (process.env.FUSION_ENV_FILE !== undefined ? process.env.FUSION_ENV_FILE : savedEnvFile());
  if (envFile) {
    if (!isAbsolute(envFile)) throw new Error('Env file path must be absolute');
    try { process.loadEnvFile(assertPrivatePath(envFile, false)); }
    catch { throw new Error('Configured env file is unavailable or invalid'); }
  }
  const command = args[0] ?? 'stdio';
  if (!['stdio', 'http', 'doctor', 'config'].includes(command) || (command === 'config' && args[1] !== 'doctor')) throw new Error('Unknown command; run fusion-jev --help');
  const config = loadConfig();
  if (config.routing.fallback !== 'host') throw new Error('The MCP CLI uses the current Codex or ChatGPT host for GPT reasoning; set FUSION_FALLBACK=host.');
  const httpWorkspace = process.env.FUSION_WORKSPACE_ROOT;
  const exposeHttpWorkspace = config.http.enableWorkspace;
  if (exposeHttpWorkspace && !httpWorkspace) throw new Error('FUSION_HTTP_ENABLE_WORKSPACE requires FUSION_WORKSPACE_ROOT');
  if (command === 'doctor' || command === 'config') {
    const mode = command === 'config' ? args[2] ?? 'stdio' : args[1] ?? 'stdio';
    if (!['stdio', 'http'].includes(mode)) throw new Error('Doctor mode must be stdio or http');
    if (mode === 'stdio') configuredWorkspaceRoots();
    const warnings: string[] = [];
    if (!config.jev.apiKey) warnings.push('Official TypeSafe key missing: Jev requests will escalate to the host. Deterministic local workspace tools remain available. Set TYPESAFE_API_KEY or configure a trusted env file with fusion-jev config env-file ABSOLUTE_PATH.');
    if (mode === 'http') validateHttpConfig(config);
    if (mode === 'http' && exposeHttpWorkspace && httpWorkspace) {
      if (!isAbsolute(httpWorkspace)) throw new Error('FUSION_WORKSPACE_ROOT must be absolute for HTTP');
      new WorkspaceService(httpWorkspace, { route: async () => { throw new Error('Diagnostic mode cannot route'); } });
    }
    process.stdout.write(JSON.stringify({ status: 'ready', localTools: 'available', mode,
      profile: config.mcpProfile,
      effectiveProfile: mode === 'http' && !exposeHttpWorkspace ? 'core' : config.mcpProfile,
      providers: { jev: config.jev.apiKey ? 'configured' : 'missing', gpt: 'host' },
      fallback: config.routing.fallback, catalogTools: config.catalog.length,
      mcpTools: mcpToolNames(config.mcpProfile, mode === 'stdio' || exposeHttpWorkspace),
      workspace: mode === 'http' ? exposeHttpWorkspace ? 'server-root' : 'disabled' : 'local',
      httpAuthentication: config.http.oauth ? 'oauth' : config.http.bearerToken ? 'local-bearer' : 'none',
      warnings, liveConnectivity: 'not-tested' }, null, 2) + '\n');
    
    return;
  }
  const router = new FusionRouter({ config, jev: config.jev.apiKey ? new JevProvider(config.jev) : undefined });
  const controller = new AbortController();
  if (command === 'stdio') {
    const { defaultRoot, allowedRoots } = configuredWorkspaceRoots();
    const workspaces = new Map<string, WorkspaceService>();
    const server = await startStdioServer({ router, config, evidence: evidenceStore(),
      workspaceFactory: root => {
        let key: string;
        try { key = realpathSync.native(root ?? defaultRoot); }
        catch { throw new WorkspaceError('INVALID_PATH', 'Workspace root is unavailable'); }
        const cached = workspaces.get(key);
        if (cached) { workspaces.delete(key); workspaces.set(key, cached); return cached; }
        const service = new WorkspaceService(key, router);
        if (!allowedRoots.has(service.root))
          throw new WorkspaceError('INVALID_PATH', 'Workspace root is not approved for this server');
        workspaces.set(key, service);
        if (workspaces.size > 16) workspaces.delete(workspaces.keys().next().value!);
        return service;
      }, signal: controller.signal });
    const close = async () => { controller.abort(); await server.close(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } else {
    if (exposeHttpWorkspace && httpWorkspace && !isAbsolute(httpWorkspace)) throw new Error('FUSION_WORKSPACE_ROOT must be absolute for HTTP');
    const workspace = exposeHttpWorkspace && httpWorkspace ? new WorkspaceService(httpWorkspace, router) : undefined;
    const server = await startHttpServer({ router, config, workspace, signal: controller.signal });
    process.stderr.write(`Fusion HTTP listening on port ${(server.address() as { port: number }).port}\n`);
    const close = () => { controller.abort(); server.close(); server.closeAllConnections(); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}

main().catch(error => {
  // Configuration diagnostics use static messages; provider bodies never reach stderr.
  process.stderr.write(`Fusion: ${error instanceof Error ? error.message : 'startup failed'}\n`);
  process.exitCode = 1;
});
