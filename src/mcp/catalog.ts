/** Which tools each profile advertises, and the compact schemas advertised for the default assist profile. */
import type { FusionConfig } from '../types.js';

// The registered zod schemas still validate every call; these only keep tools/list small (guarded by mcp-schema-budget).
const S = { type: 'string' },
  I = { type: 'integer' },
  B = { type: 'boolean' };
const slimRoot = { root: { ...S, description: 'Host-selected absolute root' } };
export const slimTools: Record<
  string,
  { description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }
> = {
  fusion_assist: {
    description: 'Bounded evidence gathering for a short task; commands return to host.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        ...slimRoot,
        task: { ...S, maxLength: 4000 },
        scope: S,
        continuation: S,
        evidenceIds: { type: 'array', maxItems: 16, items: S },
        maxActions: { ...I, maximum: 6 },
        maxJevCalls: { ...I, maximum: 2 },
      },
    },
  },
  fusion_inspect: {
    description:
      'Batch 1-8 read-only ops: outline/symbol (big files), grep (regex, ranked), read (repeat=unchanged; fresh), search (literal), list, git_*.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['requests'],
      properties: {
        ...slimRoot,
        maxChars: { ...I, minimum: 2000, maximum: 64000 },
        requests: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            properties: {
              action: {
                enum: ['list', 'read', 'search', 'outline', 'symbol', 'grep', 'git_status', 'git_diff', 'git_log'],
              },
              path: S,
              startLine: I,
              maxLines: { ...I, maximum: 300 },
              fresh: B,
              name: S,
              pattern: S,
              glob: S,
              ignoreCase: B,
              mode: { enum: ['content', 'files', 'count'] },
              topK: { ...I, maximum: 50 },
              contextLines: { ...I, maximum: 20 },
              query: { oneOf: [S, { type: 'array', maxItems: 8, items: S }] },
              maxResults: I,
              offset: I,
              staged: B,
            },
          },
        },
      },
    },
  },
  fusion_evidence: {
    description: 'Get receipt bytes or import host research (untrusted).',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'id'],
          properties: {
            action: { const: 'get' },
            id: S,
            startByte: I,
            maxBytes: { ...I, maximum: 65536 },
            expectedSha256: S,
            format: { enum: ['base64', 'utf8'] },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'url', 'retrievedAt', 'passageId', 'passage', 'sourceTool'],
          properties: {
            action: { const: 'import' },
            url: S,
            title: S,
            retrievedAt: S,
            passageId: S,
            passage: S,
            sourceTool: { enum: ['host_search', 'host_browser', 'host_docs'] },
          },
        },
      ],
    },
  },
};

const coreToolNames = ['fusion_choose', 'fusion_choose_batch', 'fusion_route', 'fusion_route_batch'] as const;
const fullWorkspaceToolNames = [
  'fusion_repo_overview',
  'fusion_inspect',
  'fusion_list_files',
  'fusion_read_file',
  'fusion_search_text',
  'fusion_git_status',
  'fusion_git_diff',
  'fusion_git_log',
  'fusion_workspace',
  ...coreToolNames,
  'fusion_assist',
  'fusion_evidence',
] as const;

export function mcpToolNames(profile: FusionConfig['mcpProfile'], hasWorkspace: boolean): string[] {
  if (!hasWorkspace) return [...coreToolNames];
  return profile === 'full' ? [...fullWorkspaceToolNames] : ['fusion_assist', 'fusion_inspect', 'fusion_evidence'];
}
