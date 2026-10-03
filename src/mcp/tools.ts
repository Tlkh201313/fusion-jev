/** Direct workspace tools (no model call) plus fusion_assist and fusion_workspace. Each tool has its own register function. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { repositoryOverview } from '../overview.js';
import { renderAction } from '../workspace-render.js';
import type { ToolContext } from './context.js';
import { actionContent, appliedLimit, assistResultContent, exceedsResultLimit, limitNotice, resultContent, resultLimit, workspaceFailure } from './render.js';
import type { ToolSpecs } from './schemas.js';

export function registerOverviewTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_repo_overview', specs.overview, async (input, extra) => {
    try {
      const { text, structuredContent } = await repositoryOverview(ctx.getWorkspace(input.root), ctx.actionSignal(extra.signal),
        input.maxChars ?? (input.detail === 'deep' ? 24000 : 16000), input.detail ?? 'standard');
      return { content: [{ type: 'text' as const, text }], structuredContent };
    } catch (error) { return workspaceFailure(error); }
  });
}

export function registerListTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_list_files', specs.list, async (input, extra) => {
    try {
      const result = await ctx.getWorkspace(input.root).list(input.path, resultLimit(input.maxResults, 30), input.offset, ctx.actionSignal(extra.signal));
      return actionContent({ ...result, limitApplied: exceedsResultLimit(input.maxResults) }, limitNotice(input.maxResults) + renderAction(result), input.format);
    } catch (error) { return workspaceFailure(error); }
  });
}

export function registerReadTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_read_file', specs.read, async (input, extra) => {
    try {
      const result = await ctx.getWorkspace(input.root).read(input.path, input.startLine, input.maxLines, ctx.actionSignal(extra.signal));
      return actionContent(result, renderAction(result), input.format);
    } catch (error) { return workspaceFailure(error); }
  });
}

export function registerSearchTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_search_text', specs.search, async (input, extra) => {
    try {
      const result = await ctx.getWorkspace(input.root).search(input.query, input.path, resultLimit(input.maxResults, 20), ctx.actionSignal(extra.signal), input);
      return actionContent({ ...result, limitApplied: exceedsResultLimit(input.maxResults) }, limitNotice(input.maxResults) + renderAction(result), input.format);
    } catch (error) { return workspaceFailure(error); }
  });
}

export function registerGitTools(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  for (const [name, descriptor, command] of [
    ['fusion_git_status', specs.status, 'status'], ['fusion_git_diff', specs.diff, 'diff'],
    ['fusion_git_log', specs.log, 'log'],
  ] as const) server.registerTool(name, descriptor, async (input, extra) => {
    try {
      const result = await ctx.getWorkspace(input.root).git(command, ctx.actionSignal(extra.signal));
      return actionContent(result, renderAction(result), input.format);
    } catch (error) { return workspaceFailure(error); }
  });
}

export function registerAssistTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_assist', specs.assist, async (input, extra) => {
    try { return assistResultContent(await ctx.getAssistance(input.root).assist(input, ctx.mergedSignal(extra.signal))); }
    catch (error) { return workspaceFailure(error); }
  });
}

export function registerWorkspaceTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_workspace', specs.workspace, async (input, extra) => {
    try {
      const result = await ctx.getWorkspace(input.root).run({ ...input, maxResults: resultLimit(input.maxResults, 50) }, ctx.mergedSignal(extra.signal));
      return resultContent(input.maxResults !== undefined && exceedsResultLimit(input.maxResults)
        ? { ...result, limitApplied: appliedLimit(input.maxResults) } : result);
    } catch (error) { return workspaceFailure(error); }
  });
}
