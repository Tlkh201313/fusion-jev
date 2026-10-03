/** Builds the MCP server: shared context, per-tool registration and the profile-aware tools/list handler. */
import { isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AssistanceService } from '../assist.js';
import { EvidenceStore } from '../evidence.js';
import { WorkspaceError, type WorkspaceService } from '../workspace.js';
import { mcpToolNames, slimTools } from './catalog.js';
import type { McpOptions, ToolContext } from './context.js';
import { registerEvidenceTool } from './evidence-tool.js';
import { registerInspectTool } from './inspect.js';
import {
  registerChooseBatchTool,
  registerChooseTool,
  registerRouteBatchTool,
  registerRouteTool,
} from './routing-tools.js';
import { createToolSpecs, evidenceSchema, type ToolSpecs } from './schemas.js';
import {
  registerAssistTool,
  registerGitTools,
  registerListTool,
  registerOverviewTool,
  registerReadTool,
  registerSearchTool,
  registerWorkspaceTool,
} from './tools.js';

const assistanceByEvidence = new WeakMap<EvidenceStore, Map<string, AssistanceService>>();

function createToolContext(
  { router, config, workspace, workspaceFactory, signal, evidence }: McpOptions,
  requestSignal: (() => AbortSignal | undefined) | undefined,
): ToolContext {
  const evidenceStore = evidence ?? new EvidenceStore();
  const mergedSignal = (other: AbortSignal) => {
    const signals = [other, signal, requestSignal?.()].filter((item): item is AbortSignal => item !== undefined);
    return signals.length === 1 ? other : AbortSignal.any(signals);
  };
  const getWorkspace = (root?: string): WorkspaceService => {
    if (root && !isAbsolute(root)) throw new WorkspaceError('INVALID_PATH', 'root must be an absolute directory');
    if (workspace) {
      if (root && resolve(root) !== workspace.root)
        throw new WorkspaceError('INVALID_PATH', 'root does not match this server');
      return workspace;
    }
    if (workspaceFactory) return workspaceFactory(root);
    throw new WorkspaceError('INVALID_REQUEST', 'Workspace actions are unavailable');
  };
  const getAssistance = (root?: string): AssistanceService => {
    const service = getWorkspace(root);
    let byRoot = assistanceByEvidence.get(evidenceStore);
    if (!byRoot) {
      byRoot = new Map();
      assistanceByEvidence.set(evidenceStore, byRoot);
    }
    let assistance = byRoot.get(service.root);
    if (!assistance) {
      assistance = new AssistanceService(service, router, evidenceStore);
      byRoot.set(service.root, assistance);
    }
    return assistance;
  };
  return {
    router,
    config,
    evidence: evidenceStore,
    getWorkspace,
    getAssistance,
    mergedSignal,
    actionSignal: (other) => AbortSignal.any([mergedSignal(other), AbortSignal.timeout(15000)]),
  };
}

function registerTools(server: McpServer, ctx: ToolContext, specs: ToolSpecs, hasWorkspace: boolean): void {
  if (hasWorkspace) {
    registerOverviewTool(server, ctx, specs);
    registerListTool(server, ctx, specs);
    registerReadTool(server, ctx, specs);
    registerSearchTool(server, ctx, specs);
    registerGitTools(server, ctx, specs);
    registerEvidenceTool(server, ctx, specs);
    registerAssistTool(server, ctx, specs);
    registerInspectTool(server, ctx, specs);
  }
  registerChooseTool(server, ctx, specs);
  registerChooseBatchTool(server, ctx, specs);
  registerRouteTool(server, ctx, specs);
  registerRouteBatchTool(server, ctx, specs);
  if (hasWorkspace) registerWorkspaceTool(server, ctx, specs);
}

/**
 * SDK v1 preserves _meta but drops top-level plugin security schemes, so tools/list exposes both forms: ChatGPT can
 * discover OAuth while standard MCP clients work. The default assist profile advertises the compact schemas.
 */
function listTools(config: McpOptions['config'], specs: ToolSpecs, hasWorkspace: boolean) {
  const { securitySchemes } = specs;
  const descriptors = new Map<
    string,
    {
      title: string;
      description: string;
      inputSchema: z.ZodType;
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
      _meta: { securitySchemes: typeof securitySchemes };
    }
  >([
    ['fusion_repo_overview', specs.overview],
    ['fusion_inspect', specs.inspect],
    ['fusion_list_files', specs.list],
    ['fusion_read_file', specs.read],
    ['fusion_search_text', specs.search],
    ['fusion_git_status', specs.status],
    ['fusion_git_diff', specs.diff],
    ['fusion_git_log', specs.log],
    ['fusion_workspace', specs.workspace],
    ['fusion_choose', specs.choose],
    ['fusion_choose_batch', specs.chooseBatch],
    ['fusion_route', specs.route],
    ['fusion_route_batch', specs.routeBatch],
    ['fusion_assist', specs.assist],
    ['fusion_evidence', specs.evidence],
  ]);
  const slim = config.mcpProfile !== 'full' && hasWorkspace;
  return {
    tools: mcpToolNames(config.mcpProfile, hasWorkspace).map((name) => {
      if (slim && slimTools[name])
        return {
          name,
          ...slimTools[name]!,
          ...(config.http.oauth ? { securitySchemes, _meta: { securitySchemes } } : {}),
        };
      const tool = descriptors.get(name)!;
      return {
        name,
        ...tool,
        securitySchemes,
        inputSchema:
          name === 'fusion_evidence'
            ? { type: 'object' as const, oneOf: evidenceSchema.options.map((option) => z.toJSONSchema(option)) }
            : (z.toJSONSchema(tool.inputSchema) as { type: 'object'; [key: string]: unknown }),
      };
    }),
  };
}

export function createFusionMcpServer(options: McpOptions, requestSignal?: () => AbortSignal | undefined): McpServer {
  const { config, workspace, workspaceFactory } = options;
  const ctx = createToolContext(options, requestSignal);
  const hasWorkspace = Boolean(workspace || workspaceFactory);
  const workspaceHint = workspace
    ? 'This server has a fixed workspace; omit root.'
    : workspaceFactory
      ? "Pass the active project's absolute root; local stdio accepts host-selected roots by default. Restricted mode uses configured roots. Use path for subdirectories."
      : '';
  const serverInfo = { name: 'fusion-jev', title: 'Fusion Jev', version: '0.3.1' };
  const server = new McpServer(serverInfo, {
    instructions:
      `Use Fusion inspection first for every supported read/list/search/Git check, command and minor repo task, even small reads. fusion_inspect: known ops; fusion_assist: uncertain tasks; fusion_evidence: receipts. Jev picks validated IDs; no extra Jev approval. Run fusion-jev run -- program argv... if installed globally, else npx -y fusion-jev@${serverInfo.version} run -- program argv... (--raw for short output; PowerShell: '--'). Host reasons, edits and verifies. RTK/native tools only on failure/unsupported work. ${hasWorkspace ? workspaceHint : 'No workspace is exposed.'}`.trim(),
  });
  const specs = createToolSpecs(config);
  registerTools(server, ctx, specs, hasWorkspace);
  server.server.setRequestHandler(ListToolsRequestSchema, () => listTools(config, specs, hasWorkspace));
  return server;
}

export async function startStdioServer(options: McpOptions): Promise<McpServer> {
  const server = createFusionMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
