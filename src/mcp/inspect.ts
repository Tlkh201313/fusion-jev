/** fusion_inspect: a batch of 1-8 read-only workspace operations with duplicate suppression, repeat-read memory and evidence receipts. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EvidenceReceipt, EvidenceStore } from '../evidence.js';
import { outlineLanguage } from '../outline.js';
import { fitBlocks } from '../overview.js';
import { compactOutline, renderAction, workspaceFailureText } from '../workspace-render.js';
import {
  WorkspaceError,
  type GrepResult,
  type OutlineActionResult,
  type ReadResult,
  type SearchResult,
  type SymbolResult,
  type WorkspaceActionResult,
  type WorkspaceService,
} from '../workspace.js';
import type { ToolContext } from './context.js';
import { limitNotice, resultLimit, workspaceFailure } from './render.js';
import type { InspectRequest, ToolSpecs } from './schemas.js';

const READ_MEMORY_LIMIT = 200;
type ReadMemo = { request: number; sha256: string; lines: string[] };
type SourceResult = ReadResult | SymbolResult | SearchResult | OutlineActionResult | GrepResult;
type EvidenceRef = { receipt: EvidenceReceipt } | { path: string; status: 'unavailable' };
type InspectOutcome = { text: string; error: boolean; duplicateOf?: number; evidenceRefs?: EvidenceRef[] };

/** Per-session memory of what inspect already returned, so a repeated read costs one line instead of the text again. */
class ReadMemory {
  private readonly memos = new Map<string, ReadMemo>();
  private counter = 0;

  nextRequestNumber(): number {
    return ++this.counter;
  }

  private remember(key: string, memo: ReadMemo): void {
    this.memos.delete(key);
    this.memos.set(key, memo);
    if (this.memos.size > READ_MEMORY_LIMIT) this.memos.delete(this.memos.keys().next().value!);
  }

  /** One-line replacement for a read the host has already seen, or the changed lines when only a few moved. */
  dedupeRead(
    service: WorkspaceService,
    request: { action: string; fresh?: boolean | undefined },
    result: ReadResult | SymbolResult,
    requestNo: number,
  ): string | undefined {
    const sha = result.sha256;
    if (!sha || !result.lines.length) return undefined;
    const first = result.lines[0]!.number;
    const last = result.lines[result.lines.length - 1]!.number;
    const key = `${service.root}\0${request.action}\0${result.path}\0${'op' in result ? result.symbol.name : ''}\0${first}-${last}`;
    const texts = result.lines.map((line) => line.text);
    const previous = this.memos.get(key);
    if (previous && !request.fresh) {
      if (previous.sha256 === sha)
        return `${result.path}:${first}-${last} unchanged since request #${previous.request} (sha256 ${sha.slice(0, 8)}); not repeated. Pass fresh=true to see it again.`;
      this.remember(key, { request: requestNo, sha256: sha, lines: texts });
      if (previous.lines.length === texts.length && previous.lines.every((text, i) => text === texts[i]))
        return `${result.path}:${first}-${last} unchanged since request #${previous.request}; file changed elsewhere (sha256 ${previous.sha256.slice(0, 8)} -> ${sha.slice(0, 8)}).`;
      const changed = texts.flatMap((text, i) =>
        previous.lines.length === texts.length && previous.lines[i] !== text ? [`${first + i}: ${text}`] : [],
      );
      if (changed.length && changed.length <= 10 && !result.shortenedLines)
        return [
          `${result.path}:${first}-${last} changed since request #${previous.request}; ${changed.length} of ${texts.length} lines differ:`,
          ...changed,
        ].join('\n');
      return undefined;
    }
    this.remember(key, { request: requestNo, sha256: sha, lines: texts });
    return undefined;
  }

  dedupeOutline(
    service: WorkspaceService,
    request: { fresh?: boolean | undefined },
    result: OutlineActionResult,
    requestNo: number,
  ): string | undefined {
    const key = `${service.root}\0outline\0${result.path}`;
    const previous = this.memos.get(key);
    if (previous && previous.sha256 === result.sha256 && !request.fresh)
      return `${result.path} outline unchanged since request #${previous.request} (sha256 ${result.sha256.slice(0, 8)}); not repeated.`;
    this.remember(key, { request: requestNo, sha256: result.sha256, lines: [] });
    return undefined;
  }
}

function executeRequest(
  service: WorkspaceService,
  request: InspectRequest,
  signal: AbortSignal,
): Promise<WorkspaceActionResult> {
  switch (request.action) {
    case 'list':
      return service.list(request.path, resultLimit(request.maxResults, 30), request.offset, signal);
    case 'read':
      return service.read(request.path, request.startLine, request.maxLines ?? 80, signal);
    case 'search':
      return service.search(request.query, request.path, resultLimit(request.maxResults, 20), signal, request);
    case 'outline':
      return service.outline(request.path, signal);
    case 'symbol':
      return service.symbol(request.path, request.name, request.contextLines, signal);
    case 'grep':
      return service.grep(request, signal);
    default:
      return service.git(
        request.action === 'git_status' ? 'status' : request.action === 'git_diff' ? 'diff' : 'log',
        signal,
        request,
      );
  }
}

/** Results backed by file bytes (as opposed to directory listings and Git output). */
function isSourceResult(result: WorkspaceActionResult): result is SourceResult {
  return 'op' in result || 'lines' in result || 'matches' in result;
}

function sourcePaths(result: SourceResult): string[] {
  if ('op' in result) {
    if (result.op !== 'grep') return [result.path];
    return [...new Set((result.mode === 'content' ? result.matches : result.files).map((item) => item.path))];
  }
  return 'lines' in result ? [result.path] : [...new Set(result.matches.map((hit) => hit.path))];
}

/** Receipts for the bytes behind a result, or a derived receipt of the rendered answer when no complete capture exists. */
function captureEvidence(
  store: EvidenceStore,
  service: WorkspaceService,
  request: InspectRequest,
  result: WorkspaceActionResult,
  rendered: string,
): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  if (isSourceResult(result)) {
    const sourceKind = 'op' in result ? result.op : 'lines' in result ? 'read' : 'search';
    const streamed = 'streamed' in result && result.streamed;
    const uncaptured = new Set<string>(
      streamed ? [result.path] : 'uncaptured' in result ? (result.uncaptured ?? []) : [],
    );
    const captures = new Map(service.sourceCaptures(result).map((snapshot) => [snapshot.path, snapshot]));
    let derived: EvidenceReceipt | undefined;
    for (const path of sourcePaths(result)) {
      try {
        const snapshot = captures.get(path);
        if (!snapshot && uncaptured.has(path)) {
          // Streamed or budget-limited files have no complete byte capture; keep the rendered answer as the receipt.
          derived ??= store.capture({
            source: { kind: 'derived_workspace', root: service.root, path, operation: 'search', query: sourceKind },
            bytes: Buffer.from(rendered),
            originalBytes: null,
            truncated: true,
          });
          refs.push({ receipt: derived });
          continue;
        }
        if (!snapshot) throw new Error('Source capture unavailable');
        refs.push({
          receipt: store.capture({
            source: { kind: 'workspace', root: service.root, path: snapshot.path },
            bytes: snapshot.bytes,
            originalBytes: snapshot.originalBytes,
          }),
        });
      } catch {
        refs.push({ path, status: 'unavailable' });
      }
    }
    return refs;
  }
  try {
    const gitBytes = 'command' in result ? service.gitCapture(result) : undefined;
    if ('command' in result && !gitBytes) throw new Error('Git capture unavailable');
    const source =
      'entries' in result
        ? { kind: 'derived_workspace' as const, root: service.root, path: result.path, operation: 'list' as const }
        : { kind: 'command' as const, cwd: service.root, argv: result.argv, channel: 'stdout' as const };
    refs.push({
      receipt: store.capture({
        source,
        bytes: gitBytes ?? Buffer.from(rendered),
        originalBytes: result.truncated ? null : undefined,
        truncated: result.truncated,
      }),
    });
  } catch {
    refs.push({
      path: request.action === 'list' ? (request.path ?? '.') : `git ${request.action.slice(4)}`,
      status: 'unavailable',
    });
  }
  return refs;
}

/** Execute and render one request. Failures become per-request error text so the rest of the batch still runs. */
async function runRequest(
  ctx: ToolContext,
  memory: ReadMemory,
  batch: { executed: number },
  service: WorkspaceService,
  request: InspectRequest,
  signal: AbortSignal,
): Promise<InspectOutcome> {
  try {
    if (signal.aborted)
      throw new WorkspaceError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', 'Inspection stopped');
    batch.executed++;
    const requestNo = memory.nextRequestNumber();
    const result = await executeRequest(service, request, signal);
    let body: string | undefined;
    if ((request.action === 'read' || request.action === 'symbol') && 'lines' in result)
      body = memory.dedupeRead(service, request, result, requestNo);
    else if (request.action === 'outline' && 'op' in result && result.op === 'outline')
      body = memory.dedupeOutline(service, request, result, requestNo);
    if (body === undefined) {
      body = renderAction(result);
      // A big file read without a range gets a compact symbol map so the next read can be targeted.
      if (
        request.action === 'read' &&
        request.startLine === undefined &&
        request.maxLines === undefined &&
        'nextLine' in result &&
        result.nextLine !== null &&
        !('streamed' in result && result.streamed) &&
        'path' in result &&
        outlineLanguage(result.path)
      ) {
        try {
          body = `${compactOutline(await service.outline(request.path, signal))}\n${body}`;
        } catch {
          /* The read itself is already complete evidence. */
        }
      }
    }
    const rendered = limitNotice('maxResults' in request ? request.maxResults : undefined) + body;
    return {
      text: rendered,
      error: false,
      evidenceRefs: captureEvidence(ctx.evidence, service, request, result, rendered),
    };
  } catch (error) {
    return { text: workspaceFailureText(error), error: true };
  }
}

export function registerInspectTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  const memory = new ReadMemory();
  server.registerTool('fusion_inspect', specs.inspect, async (input, extra) => {
    try {
      const service = ctx.getWorkspace(input.root);
      const signal = ctx.actionSignal(extra.signal);
      const results: InspectOutcome[] = new Array(input.requests.length);
      const pending = new Map<string, { index: number; promise: Promise<InspectOutcome> }>();
      const batch = { executed: 0 };
      let cursor = 0;
      // Identical requests in one batch run once; later copies point at the first.
      await Promise.all(
        Array.from({ length: Math.min(4, input.requests.length) }, async () => {
          while (cursor < input.requests.length) {
            const index = cursor++;
            const request = input.requests[index]!;
            const key = JSON.stringify(request, Object.keys(request).sort());
            const previous = pending.get(key);
            if (previous) {
              const result = await previous.promise;
              results[index] = {
                ...result,
                text: `Same as request ${previous.index + 1}.`,
                duplicateOf: previous.index + 1,
              };
            } else {
              const promise = runRequest(ctx, memory, batch, service, request, signal);
              pending.set(key, { index, promise });
              results[index] = await promise;
            }
          }
        }),
      );
      const fitted = fitBlocks(
        results.map((result, i) => ({
          label: `${i + 1} ${input.requests[i]!.action}${result.error ? ' ERROR' : ''}`,
          text: result.text,
        })),
        input.maxChars ?? 24000,
      );
      const { text } = fitted;
      const clipped = fitted.clipped.map((label) => Number.parseInt(label, 10));
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: {
          requests: results.length,
          failed: results.flatMap((r, i) => (r.error ? [i + 1] : [])),
          clipped,
          executed: batch.executed,
          modelCalls: 0,
          evidenceRefs: results.flatMap((result, index) =>
            result.duplicateOf || !result.evidenceRefs
              ? []
              : result.evidenceRefs.map((ref) => ({ request: index + 1, ...ref })),
          ),
        },
      };
    } catch (error) {
      return workspaceFailure(error);
    }
  });
}
