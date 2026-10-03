import { delimiter, isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { EvidenceStore } from '../evidence.js';
import { UsageError } from '../errors.js';
import type { WorkspaceService } from '../workspace.js';
import { evidenceStorageDir } from './storage.js';

const COMMANDS = ['stdio', 'http', 'doctor', 'config'];

function configuredWorkspaceRoots(): { defaultRoot: string; allowedRoots: Set<string> } {
  const defaultRoot = process.env.FUSION_WORKSPACE_ROOT || process.cwd();
  const requestedRoots = [
    defaultRoot,
    ...(process.env.FUSION_WORKSPACE_ALLOWED_ROOTS ?? '')
      .split(delimiter)
      .map((root) => root.trim())
      .filter(Boolean),
  ];
  const allowedRoots = new Set(
    requestedRoots.map((root) => {
      try {
        const canonical = realpathSync.native(root);
        if (!statSync(canonical).isDirectory()) throw new Error();
        return canonical;
      } catch {
        throw new Error('A configured workspace root is unavailable or is not a directory');
      }
    }),
  );
  return { defaultRoot, allowedRoots };
}

/** `stdio` (default), `http`, `doctor [stdio|http]` and its alias `config doctor [stdio|http]`. */
export async function serveCli(args: string[]): Promise<void> {
  const command = args[0] ?? 'stdio';
  if (!COMMANDS.includes(command) || (command === 'config' && args[1] !== 'doctor'))
    throw new UsageError('Unknown command; run fusion-jev --help');
  const [
    { loadConfig },
    { FusionRouter },
    { JevProvider },
    { mcpToolNames, startHttpServer, startStdioServer, validateHttpConfig },
    { WorkspaceError, WorkspaceService: Workspace },
  ] = await Promise.all([
    import('../config.js'),
    import('../router.js'),
    import('../providers/jev.js'),
    import('../mcp.js'),
    import('../workspace.js'),
  ]);
  const config = loadConfig();
  if (config.routing.fallback !== 'host')
    throw new Error('The MCP CLI uses the current Codex or ChatGPT host for GPT reasoning; set FUSION_FALLBACK=host.');
  const httpWorkspace = process.env.FUSION_WORKSPACE_ROOT;
  const exposeHttpWorkspace = config.http.enableWorkspace;
  if (exposeHttpWorkspace && !httpWorkspace)
    throw new Error('FUSION_HTTP_ENABLE_WORKSPACE requires FUSION_WORKSPACE_ROOT');
  if (command === 'doctor' || command === 'config') {
    const mode = command === 'config' ? (args[2] ?? 'stdio') : (args[1] ?? 'stdio');
    if (!['stdio', 'http'].includes(mode)) throw new UsageError('Doctor mode must be stdio or http');
    if (mode === 'stdio') configuredWorkspaceRoots();
    const warnings: string[] = [];
    if (!config.jev.apiKey)
      warnings.push(
        'Official TypeSafe key missing: Jev requests will escalate to the host. Deterministic local workspace tools remain available. Set TYPESAFE_API_KEY or configure a trusted env file with fusion-jev config env-file ABSOLUTE_PATH.',
      );
    if (mode === 'http') validateHttpConfig(config);
    if (mode === 'http' && exposeHttpWorkspace && httpWorkspace) {
      if (!isAbsolute(httpWorkspace)) throw new Error('FUSION_WORKSPACE_ROOT must be absolute for HTTP');
      new Workspace(httpWorkspace, {
        route: async () => {
          throw new Error('Diagnostic mode cannot route');
        },
      });
    }
    process.stdout.write(
      JSON.stringify(
        {
          status: 'ready',
          localTools: 'available',
          mode,
          profile: config.mcpProfile,
          effectiveProfile: mode === 'http' && !exposeHttpWorkspace ? 'core' : config.mcpProfile,
          providers: { jev: config.jev.apiKey ? 'configured' : 'missing', gpt: 'host' },
          fallback: config.routing.fallback,
          catalogTools: config.catalog.length,
          mcpTools: mcpToolNames(config.mcpProfile, mode === 'stdio' || exposeHttpWorkspace),
          workspace: mode === 'http' ? (exposeHttpWorkspace ? 'server-root' : 'disabled') : 'local',
          httpAuthentication: config.http.oauth ? 'oauth' : config.http.bearerToken ? 'local-bearer' : 'none',
          warnings,
          liveConnectivity: 'not-tested',
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const router = new FusionRouter({ config, jev: config.jev.apiKey ? new JevProvider(config.jev) : undefined });
  const controller = new AbortController();
  if (command === 'stdio') {
    const { defaultRoot, allowedRoots } = configuredWorkspaceRoots();
    const workspaces = new Map<string, WorkspaceService>();
    const server = await startStdioServer({
      router,
      config,
      evidence: new EvidenceStore({ storageDir: evidenceStorageDir() }),
      workspaceFactory: (root) => {
        let key: string;
        try {
          key = realpathSync.native(root ?? defaultRoot);
        } catch {
          throw new WorkspaceError('INVALID_PATH', 'Workspace root is unavailable');
        }
        const cached = workspaces.get(key);
        if (cached) {
          workspaces.delete(key);
          workspaces.set(key, cached);
          return cached;
        }
        const service = new Workspace(key, router);
        if (!allowedRoots.has(service.root))
          throw new WorkspaceError('INVALID_PATH', 'Workspace root is not approved for this server');
        workspaces.set(key, service);
        if (workspaces.size > 16) workspaces.delete(workspaces.keys().next().value!);
        return service;
      },
      signal: controller.signal,
    });
    const close = async () => {
      controller.abort();
      await server.close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } else {
    if (exposeHttpWorkspace && httpWorkspace && !isAbsolute(httpWorkspace))
      throw new Error('FUSION_WORKSPACE_ROOT must be absolute for HTTP');
    const workspace = exposeHttpWorkspace && httpWorkspace ? new Workspace(httpWorkspace, router) : undefined;
    const server = await startHttpServer({ router, config, workspace, signal: controller.signal });
    process.stderr.write(`Fusion HTTP listening on port ${(server.address() as { port: number }).port}\n`);
    const close = () => {
      controller.abort();
      server.close();
      server.closeAllConnections();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
}
