/** Zod input schemas and tool descriptors. These validate every call; the advertised schemas live in catalog.ts. */
import { z } from 'zod';
import type { FusionConfig } from '../types.js';
import { researchImportSchema } from '../research.js';

const toolSchema = z.strictObject({
  name: z.string().min(1), description: z.string(), inputSchema: z.record(z.string(), z.unknown()), readOnly: z.boolean().optional(),
});
export const requestSchema = z.strictObject({
  task: z.string().min(1), context: z.json().optional(), tools: z.array(toolSchema).optional(),
  toolNames: z.array(z.string().min(1)).optional(),
  candidates: z.array(z.strictObject({ id: z.string().min(1), tool: z.string().min(1), arguments: z.record(z.string(), z.json()), description: z.string().optional() })).optional(),
  strategy: z.enum(['fusion', 'jev-only']).optional(), cache: z.boolean().optional(),
});
export type McpRequest = z.infer<typeof requestSchema>;

const rootField = { root: z.string().min(1).max(4096).optional()
  .describe('Exact approved absolute workspace root. Use path to select a subdirectory.') };
const formatField = { format: z.enum(['compact', 'structured']).optional().describe('Compact text by default; structured JSON for programs.') };
const pathField = z.string().min(1).max(4096);

export const evidenceSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('get'), id: z.uuid(), startByte: z.number().int().min(0).optional(),
    maxBytes: z.number().int().min(1).max(64 * 1024).optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    format: z.enum(['base64', 'utf8']).optional() }),
  researchImportSchema.extend({ action: z.literal('import') }),
]);

/** All tool descriptors for one server. Key order inside each descriptor is part of the advertised tools/list output. */
export function createToolSpecs(config: FusionConfig) {
  const securitySchemes = config.http.oauth ? [{ type: 'oauth2', scopes: config.http.oauth.scopes }] : [{ type: 'noauth' }];
  const common = { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }, _meta: { securitySchemes } };
  const workspaceCommon = { ...common, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };

  const overview = { ...workspaceCommon, title: 'Map a repository on request',
    description: 'Use only when the user explicitly asks for a repository map or architecture. Scans discovered source files and returns symbols and static module dependencies; may disclose many file names and excerpts. Prefer targeted search/read for a narrow question.',
    inputSchema: z.strictObject({ ...rootField, detail: z.enum(['standard', 'deep']).optional(),
      maxChars: z.number().int().min(4000).max(64000).optional() }) };
  const list = { ...workspaceCommon, title: 'List workspace files',
    description: 'List a directory. maxResults above 50 is capped with a notice; continue with nextOffset. No model call.',
    inputSchema: z.strictObject({ ...rootField, ...formatField, path: z.string().min(1).max(4096).optional(),
      maxResults: z.number().int().min(1).optional(), offset: z.number().int().min(0).max(10000).optional() }) };
  const read = { ...workspaceCommon, title: 'Read workspace file lines',
    description: 'Read exact numbered UTF-8 lines (default 120). Continue with nextLine. No model call.',
    inputSchema: z.strictObject({ ...rootField, ...formatField, path: z.string().min(1).max(4096), startLine: z.number().int().min(1).optional(),
      maxLines: z.number().int().min(1).max(300).optional() }) };
  const search = { ...workspaceCommon, title: 'Search literal workspace text',
    description: 'Search one or up to eight literal phrases in a single scan (OR). Add contextLines to avoid follow-up reads. maxResults above 50 is capped with a notice; continue with nextOffset.',
    inputSchema: z.strictObject({ ...rootField, ...formatField, query: z.union([z.string().min(1).max(256), z.array(z.string().min(1).max(256)).min(1).max(8)]), path: z.string().min(1).max(4096).optional(),
      maxResults: z.number().int().min(1).optional(), contextLines: z.number().int().min(0).max(3).optional(),
      offset: z.number().int().min(0).max(10000).optional() }) };
  const gitDescriptor = (title: string, description: string) => ({ ...workspaceCommon, title, description,
    inputSchema: z.strictObject({ ...rootField, ...formatField }) });
  const status = gitDescriptor('Git status', 'Show short Git working tree status. Fixed read-only command; no Jev call.');
  const diff = gitDescriptor('Git diff', 'Show bounded unstaged Git diff. Fixed read-only command; no Jev call.');
  const log = gitDescriptor('Git log', 'Show the five latest commits. Fixed read-only command; no Jev call.');

  const inspectSchema = z.discriminatedUnion('action', [
    list.inputSchema.omit({ root: true, format: true }).extend({ action: z.literal('list') }),
    read.inputSchema.omit({ root: true, format: true }).extend({ action: z.literal('read'), fresh: z.boolean().optional() }),
    search.inputSchema.omit({ root: true, format: true }).extend({ action: z.literal('search') }),
    z.strictObject({ action: z.literal('outline'), path: pathField, fresh: z.boolean().optional() }),
    z.strictObject({ action: z.literal('symbol'), path: pathField, name: z.string().min(1).max(200),
      contextLines: z.number().int().min(0).max(20).optional(), fresh: z.boolean().optional() }),
    z.strictObject({ action: z.literal('grep'), pattern: z.string().min(1).max(200), path: pathField.optional(),
      glob: z.string().min(1).max(200).optional(), ignoreCase: z.boolean().optional(), mode: z.enum(['content', 'files', 'count']).optional(),
      contextLines: z.number().int().min(0).max(3).optional(), topK: z.number().int().min(1).max(50).optional() }),
    z.strictObject({ action: z.enum(['git_status', 'git_diff', 'git_log']),
      path: pathField.optional(), staged: z.boolean().optional().describe('Git diff only; inspect index changes.') }),
  ]);
  const inspect = { ...workspaceCommon, title: 'Inspect workspace in one call',
    description: 'Batch 1-8 read-only ops, no inference. outline/symbol(name, Class.method ok) for big files; grep(pattern regex, glob, mode content|files|count, topK, contextLines<=3) ranked; read(startLine,maxLines<=300; repeats return "unchanged", fresh=true to re-read); search(query literal(s)); list; git_*.',
    inputSchema: z.strictObject({ ...rootField, requests: z.array(inspectSchema).min(1).max(8),
      maxChars: z.number().int().min(2000).max(64000).optional() }) };

  const assist = { ...workspaceCommon, title: 'Bounded repository assistance',
    description: 'Gather evidence with six fixed reads, two bounded Jev choices, and 20 seconds. Commands return to the host.',
    inputSchema: z.strictObject({ ...rootField, task: z.string().min(1).max(4000), scope: z.string().min(1).max(4096).optional(),
      continuation: z.string().uuid().optional(), evidenceIds: z.array(z.string().uuid()).max(16).optional(),
      maxActions: z.number().int().min(1).max(6).optional(), maxJevCalls: z.number().int().min(1).max(2).optional() }) };
  const evidence = { ...common,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    title: 'Import or retrieve exact evidence',
    description: 'Retrieve exact bytes or import attributed host research as untrusted evidence. No URL fetching.',
    inputSchema: z.strictObject({ action: z.enum(['get', 'import']), id: z.uuid().optional(),
      startByte: z.number().int().min(0).optional(), maxBytes: z.number().int().min(1).max(64 * 1024).optional(),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      format: z.enum(['base64', 'utf8']).optional().describe('utf8 emits text once; split UTF-8 or binary ranges fall back to exact base64.'),
      url: researchImportSchema.shape.url.optional(), title: researchImportSchema.shape.title,
      retrievedAt: researchImportSchema.shape.retrievedAt.optional(),
      passageId: researchImportSchema.shape.passageId.optional(), passage: researchImportSchema.shape.passage.optional(),
      sourceTool: researchImportSchema.shape.sourceTool.optional() }),
  };

  const choiceSchema = z.strictObject({
    task: z.string().min(1).max(4000),
    options: z.array(z.strictObject({ id: z.string().min(1).max(80), description: z.string().min(1).max(1000) })).min(2).max(config.routing.maxCandidates),
    context: z.json().optional(), cache: z.boolean().optional(),
  });
  const choose = { ...common, title: 'Ask Jev to choose',
    description: 'Bounded decision among 2–254 supplied options, subject to the configured cap. Send only short, relevant descriptions. Optional Jev requests go to the official TypeSafe API; uncertain results return control to the host. No action is executed. Skip this tool when the answer is obvious.',
    inputSchema: choiceSchema };
  const chooseBatch = { ...common, title: 'Ask Jev to choose in a batch',
    description: 'Choose among options for independent decisions in one bounded provider batch. Results preserve input order; no actions execute. Use when several ambiguous choices are already known.',
    inputSchema: z.strictObject({ requests: z.array(choiceSchema).min(1).max(config.routing.maxBatchSize) }) };
  const route = {
    ...common, title: 'Route a tool decision',
    description: 'Use optional Jev through the official TypeSafe API to choose one complete tool call, or return control to the current host model for uncertain work. No OpenAI API call is made. Omit tools to use the server catalog; toolNames selects catalog entries. Inline tools must have unique names outside the catalog.',
    inputSchema: requestSchema,
  };
  const routeBatch = {
    ...common, title: 'Route independent tool decisions',
    description: 'Route a bounded batch of independent requests. Each result corresponds to the request at the same index. No tool execution occurs.',
    inputSchema: z.strictObject({ requests: z.array(requestSchema).min(1).max(config.routing.maxBatchSize) }),
  };
  const workspace = {
    ...workspaceCommon,
    title: 'Let Jev choose a workspace action',
    description: 'Use only when the correct read-only action is ambiguous. Jev chooses among listing, reading, searching, and fixed Git inspection. Prefer the named direct tools for known actions to avoid inference cost and delay.',
    inputSchema: z.strictObject({ ...rootField, task: z.string().min(1), path: z.string().min(1).optional(),
      query: z.string().min(1).optional(), maxResults: z.number().int().min(1).optional() }),
  };
  return { securitySchemes, overview, list, read, search, status, diff, log, inspect, assist, evidence, choose, chooseBatch,
    route, routeBatch, workspace, schemas: { inspect: inspectSchema, choice: choiceSchema } };
}

export type ToolSpecs = ReturnType<typeof createToolSpecs>;
export type InspectRequest = z.infer<ToolSpecs['schemas']['inspect']>;
export type ChoiceInput = z.infer<ToolSpecs['schemas']['choice']>;
export type EvidenceInput = z.infer<typeof evidenceSchema>;
