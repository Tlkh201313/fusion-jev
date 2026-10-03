/** Compact text rendering of workspace action results, shared by the MCP tools and the repository overview. */
import { orderSymbols, renderOutline, type OutlineSymbol } from './outline.js';
import { WorkspaceError, type GrepResult, type SearchResult, type SymbolResult, type WorkspaceActionResult } from './workspace.js';

type ContextLine = { line: number; text: string; shortened?: boolean | undefined };
type Hit = { path: string; line: number; text: string; definition?: boolean | undefined; shortened?: boolean | undefined; context?: ContextLine[] | undefined };

export function listingContinuation(result: { nextOffset?: number | null; truncated?: boolean }): string | undefined {
  return result.nextOffset !== null && result.nextOffset !== undefined ? `nextOffset=${result.nextOffset}`
    : result.truncated ? 'WARNING: listing truncated at pagination limit; remaining results unavailable.' : undefined;
}

/** Stable `{code, message}` for any error raised by a workspace action; system errors are mapped to coarse codes. */
export function workspaceFailureInfo(error: unknown): { code: string; message: string } {
  const systemCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const code = error instanceof WorkspaceError ? error.code
    : systemCode === 'ENOENT' ? 'NOT_FOUND' : systemCode === 'EACCES' || systemCode === 'EPERM' ? 'ACCESS_DENIED' : 'ACTION_FAILED';
  const message = error instanceof WorkspaceError ? error.message
    : code === 'NOT_FOUND' ? 'Workspace path not found' : code === 'ACCESS_DENIED' ? 'Workspace path cannot be read' : 'Workspace action failed';
  return { code, message };
}

/** `CODE: message`, the single-line form used in text results and per-item failures. */
export function workspaceFailureText(error: unknown): string {
  const { code, message } = workspaceFailureInfo(error);
  return `${code}: ${message}`;
}

/** One row per source line across hits: adjacent matches often share context, so each line is emitted only once. */
function uniqueHitRows(matches: readonly Hit[], format: (hit: Hit, line: ContextLine) => string): string[] {
  const emitted = new Set<string>();
  const rows: string[] = [];
  for (const hit of matches) for (const line of hit.context ?? [{ line: hit.line, text: hit.text, shortened: hit.shortened }]) {
    const key = `${hit.path}:${line.line}`;
    if (!emitted.has(key)) { emitted.add(key); rows.push(format(hit, line)); }
  }
  return rows;
}

function renderGrep(result: GrepResult): string {
  const warnings = [
    ...(result.skippedFiles ? [`WARNING: ${result.skippedFiles} unreadable, binary or over-budget files skipped${result.failedPaths.length ? ` (${result.failedPaths.join(', ')})` : ''}.`] : []),
    ...(result.partialFiles ? [`WARNING: ${result.partialFiles} large files scanned only up to 1 MiB each (${result.partialPaths.join(', ')}); later matches may be missed.`] : []),
    ...(result.longLines ? [`NOTE: ${result.longLines} lines longer than 2000 chars were scanned only up to that length.`] : []),
    ...(result.timedOut ? ['WARNING: scan deadline reached; results incomplete. Narrow path or glob.'] : []),
    ...(result.scanLimited && !result.timedOut ? ['WARNING: file scan limit reached; narrow path or glob.'] : []),
    ...(result.capped ? ['WARNING: hit storage cap reached; ranking covers the first 4000 matches.'] : []),
  ];
  const summary = `matches=${result.totalMatches} files=${result.filesMatched} scanned=${result.filesScanned} skipped=${result.skippedFiles}`;
  if (result.mode === 'content') {
    const rows = uniqueHitRows(result.matches, (hit, line) => {
      const own = line.line === hit.line;
      return `${JSON.stringify(hit.path)}:${line.line}:${own && hit.definition ? ' [def]' : ''} ${line.text}${own && hit.shortened ? ' [excerpt]' : ''}`;
    });
    const more = result.totalMatches - result.matches.length;
    return [...(rows.length ? rows : ['(no matches)']), `${summary} shown=${result.matches.length}${more > 0 ? ` more=${more}; raise topK or narrow path/glob` : ''}`, ...warnings].join('\n');
  }
  const rows = result.files.map(file => result.mode === 'count' ? `${file.count} ${JSON.stringify(file.path)}` : `${JSON.stringify(file.path)} (${file.count})`);
  return [...(rows.length ? rows : ['(no matches)']), `${summary}${result.filesMatched > result.files.length ? ` more files=${result.filesMatched - result.files.length}` : ''}`, ...warnings].join('\n');
}

function renderSymbol(result: SymbolResult): string {
  const symbol = result.symbol;
  const body = result.lines.map(l => `${l.number}: ${l.text}`);
  return [`${JSON.stringify(result.path)} ${symbol.kind} ${symbol.name} ${symbol.startLine}-${symbol.endLine}${symbol.approx ? '~' : ''}${symbol.contextLines ? ` (+/-${symbol.contextLines})` : ''}`,
    ...body,
    ...(result.nextLine !== null ? [`nextLine=${result.nextLine}`] : []),
    ...(result.others.length ? [`AMBIGUOUS: also ${result.others.map(item => `${item.name} ${item.kind} ${item.startLine}-${item.endLine}`).join('; ')}${result.moreOthers ? ` (+${result.moreOthers})` : ''}. Use Parent.name to choose.`] : []),
    ...(result.shortenedLines ? ['WARNING: long lines shortened; inspect them with host tools before editing.'] : [])].join('\n');
}

function renderSearch(result: SearchResult): string {
  const rows = uniqueHitRows(result.matches, (hit, line) => `${JSON.stringify(hit.path)}:${line.line}: ${line.text}${line.shortened ? ' [excerpt]' : ''}`);
  return [...(rows.length ? rows : ['(no matches)']), `matches=${result.matches.length} scanned=${result.filesScanned} skipped=${result.skippedFiles}`,
    ...(result.nextOffset !== null ? [`nextOffset=${result.nextOffset}`]
      : result.truncated ? ['WARNING: results incomplete; no nextOffset available. Narrow the search.'] : []),
    ...(result.scanLimited ? ['WARNING: scan limit reached; narrow path.'] : []),
    ...(result.partialFiles ? [`WARNING: ${result.partialFiles} large files scanned only up to 1 MiB each (${(result.partialPaths ?? []).join(', ')}); results are incomplete.`] : []),
    ...(result.skippedFiles ? ['WARNING: unreadable, binary or oversized files skipped; results are incomplete.'] : [])].join('\n');
}

/** Render any inspection result as the compact text the host sees. */
export function renderAction(result: WorkspaceActionResult): string {
  if ('op' in result) {
    switch (result.op) {
      case 'outline': return renderOutline(result.path, result, { complete: result.complete });
      case 'symbol': return renderSymbol(result);
      case 'grep': return renderGrep(result);
    }
  }
  if ('entries' in result) {
    const continuation = listingContinuation(result);
    return [`${result.path}/`, ...result.entries.map(e => `${e.type === 'directory' ? 'd' : 'f'} ${JSON.stringify(e.name)}`),
      ...(continuation ? [continuation] : [])].join('\n');
  }
  if ('lines' in result) return [JSON.stringify(result.path), ...result.lines.map(l => `${l.number}: ${l.text}`),
    ...(result.nextLine !== null ? [`nextLine=${result.nextLine}`] : []),
    ...(result.shortenedLines ? ['WARNING: long lines shortened; inspect them with host tools before editing.'] : [])].join('\n');
  if ('matches' in result) return renderSearch(result);
  return `${result.command}\n${result.text || '(no output)'}${result.truncated ? '\nWARNING: output truncated; use a scoped host command for the remainder.' : ''}`;
}

/** One-line symbol map shown above a big unranged read so the next read can be targeted. */
export function compactOutline(outline: { symbols: OutlineSymbol[]; totalLines: number }): string {
  const top = orderSymbols(outline.symbols).filter(symbol => !symbol.parent);
  const parts: string[] = [];
  let chars = 0;
  for (const symbol of top) {
    const part = `${symbol.name}:${symbol.startLine}-${symbol.endLine}`;
    if (chars + part.length > 600) break;
    parts.push(part); chars += part.length + 2;
  }
  return `Outline of ${outline.totalLines} lines (name:start-end, exported first)${top.length > parts.length ? `, ${top.length - parts.length} more via outline` : ''}: ${parts.join(', ') || '(no symbols)'}`;
}
