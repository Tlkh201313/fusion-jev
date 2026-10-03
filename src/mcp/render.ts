/** MCP result envelopes: what crosses the tool boundary, as opposed to the text rendering in workspace-render.ts. */
import type { AssistResult } from '../assist.js';
import { workspaceFailureInfo } from '../workspace-render.js';

export function resultContent<T extends object>(result: T) {
  // Only decisions and accounting cross the MCP boundary; provider probability tables stay internal.
  const structuredContent = { ...result } as Record<string, unknown>;
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

export function assistResultContent(result: AssistResult) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const visible = resultContent(result);
    const bytes = Buffer.byteLength(JSON.stringify(visible));
    if (result.telemetry.hostVisibleBytes === bytes) return visible;
    result.telemetry.hostVisibleBytes = bytes;
  }
  return resultContent(result);
}

export function actionContent(result: object, text: string, format: 'compact' | 'structured' = 'compact') {
  // Workspace evidence appears once by default. Structured mode is opt-in for machine consumers.
  return format === 'structured' ? resultContent(result) : { content: [{ type: 'text' as const, text }] };
}

export function toolError(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

export function workspaceFailure(error: unknown) {
  const { code, message } = workspaceFailureInfo(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

const MCP_RESULT_LIMIT = 50;
export const resultLimit = (requested: number | undefined, fallback: number) =>
  Math.min(requested ?? fallback, MCP_RESULT_LIMIT);
/** True when the caller asked for more results than one MCP call returns. */
export const exceedsResultLimit = (requested: number | undefined) =>
  requested !== undefined && requested > MCP_RESULT_LIMIT;
export const limitNotice = (requested: number | undefined) =>
  exceedsResultLimit(requested)
    ? `LIMIT APPLIED: maxResults=${MCP_RESULT_LIMIT}; use nextOffset if more results remain.\n`
    : '';
export const appliedLimit = (requested: number) => ({ requested, applied: MCP_RESULT_LIMIT });
