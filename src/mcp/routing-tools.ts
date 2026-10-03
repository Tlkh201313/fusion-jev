/** Jev routing tools: fusion_route, fusion_route_batch, fusion_choose and fusion_choose_batch. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Decision, FusionConfig, RouteRequest, ToolDefinition } from '../types.js';
import type { ToolContext } from './context.js';
import { resultContent, toolError } from './render.js';
import type { ChoiceInput, McpRequest, ToolSpecs } from './schemas.js';

function prepareRequest(input: McpRequest, config: FusionConfig): RouteRequest {
  const catalog = new Map(config.catalog.map(tool => [tool.name, tool]));
  if (catalog.size !== config.catalog.length) throw new Error('Catalog has duplicate tool names');
  const selected = input.toolNames === undefined ? [...catalog.values()] : input.toolNames.map(name => {
    const tool = catalog.get(name);
    if (!tool) throw new Error(`Unknown catalog tool: ${name}`);
    return tool;
  });
  const names = new Set(selected.map(tool => tool.name));
  if (names.size !== selected.length) throw new Error('Duplicate catalog tool selection');
  for (const tool of input.tools ?? []) {
    if (catalog.has(tool.name) || names.has(tool.name)) throw new Error(`Duplicate or overridden tool: ${tool.name}`);
    selected.push(tool as ToolDefinition); names.add(tool.name);
  }
  const { toolNames: _names, ...request } = input;
  const prepared = { ...request, tools: selected } as RouteRequest;
  if (Buffer.byteLength(JSON.stringify(prepared)) > config.routing.maxRequestBytes) throw new Error('Request exceeds size limit');
  return prepared;
}

function prepareChoice(input: ChoiceInput, config: FusionConfig): RouteRequest {
  const ids = new Set(input.options.map(option => option.id));
  if (ids.size !== input.options.length || ids.has('__escalate__')) throw new Error('Invalid choice IDs');
  const request: RouteRequest = {
    task: input.task, ...(input.context !== undefined ? { context: input.context } : {}),
    tools: [{ name: 'fusion_choice', description: 'Select exactly one supplied option', readOnly: true,
      inputSchema: { type: 'object', properties: { id: { enum: [...ids] } }, required: ['id'], additionalProperties: false } }],
    candidates: input.options.map(option => ({ id: option.id, tool: 'fusion_choice', arguments: { id: option.id }, description: option.description })),
    strategy: 'jev-only', ...(input.cache !== undefined ? { cache: input.cache } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(request)) > config.routing.maxRequestBytes) throw new Error('Choice request exceeds size limit');
  return request;
}

function choiceResult(decision: Decision, validIds: Set<string>) {
  if (decision.status !== 'selected') return { status: decision.status, reason: decision.reason,
    ...(decision.failureCategory ? { failureCategory: decision.failureCategory } : {}) };
  const id = decision.call.tool === 'fusion_choice' ? decision.call.arguments.id : undefined;
  if (typeof id !== 'string' || !validIds.has(id) || decision.candidateId !== id)
    return { status: 'escalate' as const, reason: 'invalid_response' as const };
  return { status: 'selected' as const, choiceId: id, confidence: decision.confidence,
    probability: decision.probability, margin: decision.margin, reuse: decision.reuse };
}

export function registerChooseTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_choose', specs.choose, async (input, extra) => {
    try {
      const result = await ctx.router.route(prepareChoice(input, ctx.config), ctx.mergedSignal(extra.signal));
      return resultContent({ ...choiceResult(result.decision, new Set(input.options.map(option => option.id))),
        usage: result.usage, latencyMs: result.latencyMs });
    } catch { return toolError('Choice failed. Check IDs, size limits and server diagnostics.'); }
  });
}

export function registerChooseBatchTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_choose_batch', specs.chooseBatch, async ({ requests }, extra) => {
    try {
      const prepared = requests.map(request => prepareChoice(request, ctx.config));
      if (Buffer.byteLength(JSON.stringify(prepared)) > ctx.config.routing.maxRequestBytes) throw new Error('Choice batch exceeds size limit');
      const result = await ctx.router.routeBatch(prepared, ctx.mergedSignal(extra.signal));
      if (result.decisions.length !== requests.length) throw new Error('Incomplete choice batch');
      return resultContent({ choices: result.decisions.map((decision, index) => choiceResult(decision,
        new Set(requests[index]!.options.map(option => option.id)))), usage: result.usage, latencyMs: result.latencyMs });
    } catch { return toolError('Choice batch failed. Check IDs, size limits and server diagnostics.'); }
  });
}

export function registerRouteTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_route', specs.route, async (input, extra) => {
    try { return resultContent(await ctx.router.route(prepareRequest(input, ctx.config), ctx.mergedSignal(extra.signal))); }
    catch { return toolError('Routing request failed. Check request validity, configured limits and server diagnostics.'); }
  });
}

export function registerRouteBatchTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  server.registerTool('fusion_route_batch', specs.routeBatch, async ({ requests }, extra) => {
    try {
      if (Buffer.byteLength(JSON.stringify(requests)) > ctx.config.routing.maxRequestBytes) throw new Error('Batch exceeds size limit');
      return resultContent(await ctx.router.routeBatch(requests.map(input => prepareRequest(input, ctx.config)), ctx.mergedSignal(extra.signal)));
    } catch { return toolError('Batch routing failed. Check request validity, configured limits and server diagnostics.'); }
  });
}
