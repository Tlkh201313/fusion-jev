import type { EvidenceStore, EvidenceReceipt } from './evidence.js';
import { scanDiagnostics, type Diagnostic } from './diagnostics.js';
import { summarizeGit } from './git-summary.js';

/** Rendered diagnostic lines may use about 575 tokens (4 bytes per token) before the rest is counted, not shown. */
export const DIAGNOSTIC_BUDGET_BYTES = 2300;

export interface ChannelSummary {
  diagnostics: Diagnostic[];
  diagnosticsOmitted: number;
  excerptsClipped: number;
  omittedBytes: number;
  unparsedBytes: number;
  smallText?: string;
  /** Compact content summary for recognized informational commands (git log, diff, status, ...). */
  informational?: string;
  /** Diagnostic counts per file, largest first, present only when diagnostics were omitted. */
  fileCounts?: Array<[string, number]>;
  filesOmitted?: number;
  unavailable?: string;
}

/** Summarize captured bytes, never infer success from log text. Child exit status is authoritative. */
export async function summarizeChannel(store: EvidenceStore, receipt: EvidenceReceipt): Promise<ChannelSummary> {
  const chunks: Buffer[] = [];
  let startByte = 0;
  do {
    const page = await store.expand({ id: receipt.id, startByte, maxBytes: 64 * 1024 });
    if (page.status !== 'ok' && page.status !== 'stale')
      return { diagnostics: [], diagnosticsOmitted: 0, excerptsClipped: 0, omittedBytes: receipt.storedBytes, unparsedBytes: receipt.storedBytes, unavailable: page.status };
    chunks.push(Buffer.from(page.dataBase64, 'base64'));
    if (page.nextByte === null) break;
    startByte = page.nextByte;
  } while (startByte < receipt.storedBytes);
  const bytes = Buffer.concat(chunks);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const diagnostics: Diagnostic[] = [];
  let totalDiagnostics = 0;
  let unparsedBytes = 0;
  const parseSegment = (start: number, end: number) => {
    if (end <= start) return;
    const found = scanDiagnostics({ text: decoder.decode(bytes.subarray(start, end)), sourceEvidenceId: receipt.id });
    totalDiagnostics += found.total;
    for (const item of found.diagnostics) diagnostics.push({ ...item, startByte: item.startByte + start, endByte: item.endByte + start });
  };
  try { parseSegment(0, bytes.length); }
  catch {
    let segmentStart = 0, lineStart = 0;
    while (lineStart < bytes.length) {
      const newline = bytes.indexOf(10, lineStart);
      const end = newline < 0 ? bytes.length : newline + 1;
      try { decoder.decode(bytes.subarray(lineStart, end)); }
      catch { parseSegment(segmentStart, lineStart); unparsedBytes += end - lineStart; segmentStart = end; }
      lineStart = end;
    }
    parseSegment(segmentStart, bytes.length);
  }
  // Small complete text is shown verbatim: it carries every diagnostic exactly, so nothing is omitted.
  const smallText = bytes.length <= 1200 && !receipt.truncated
    ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined;
  let exactSmall: string | undefined;
  try { exactSmall = smallText?.decode(bytes); } catch { /* Binary remains available through exact expansion. */ }
  if (exactSmall !== undefined) totalDiagnostics = 0;
  // Recognized informational git output gets a content summary instead of diagnostics: its text is history, not failures.
  if (exactSmall === undefined && receipt.source.kind === 'command' && receipt.source.channel === 'stdout' && !receipt.truncated && !unparsedBytes) {
    let text: string | undefined;
    try { text = decoder.decode(bytes); } catch { /* Not text: generic path. */ }
    const informational = text === undefined ? undefined : summarizeGit(receipt.source.argv, text);
    // Only used when it is clearly smaller than the raw bytes; otherwise the generic path is no worse.
    if (informational !== undefined && Buffer.byteLength(informational) * 4 < bytes.length * 3)
      return { diagnostics: [], diagnosticsOmitted: 0, excerptsClipped: 0, omittedBytes: bytes.length, unparsedBytes: 0, informational };
  }
  const shown = exactSmall === undefined ? selectDiagnostics(diagnostics, bytes) : [];
  const files = new Map<string, number>();
  if (exactSmall === undefined) for (const item of diagnostics) if (item.file) files.set(item.file, (files.get(item.file) ?? 0) + 1);
  const ranked = [...files].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  const omitted = totalDiagnostics - shown.length;
  return { diagnostics: shown, diagnosticsOmitted: omitted,
    excerptsClipped: shown.filter(diagnostic => diagnostic.message.length > 200).length,
    omittedBytes: exactSmall === undefined ? bytes.length : 0, unparsedBytes,
    ...(omitted > 0 && ranked.length > 1 ? { fileCounts: ranked.slice(0, 8), filesOmitted: Math.max(0, ranked.length - 8) } : {}),
    ...(exactSmall === undefined ? {} : { smallText: exactSmall }) };
}

const codeOf = (diagnostic: Diagnostic, bytes: Buffer) =>
  /TSd+/.exec(bytes.subarray(diagnostic.startByte, diagnostic.endByte).toString('utf8'))?.[0] ?? '';

function renderDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.file ? `${diagnostic.file}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}: ` : '';
  return `${location}${diagnostic.severity}: ${diagnostic.message.slice(0, 200)}${diagnostic.message.length > 200 ? ' [excerpt clipped]' : ''} [${diagnostic.evidenceId}:${diagnostic.startByte}-${diagnostic.endByte}]`;
}

/** Fill a byte budget: errors before warnings, the first of each distinct code/message first, then the rest in order; shown in source order. */
function selectDiagnostics(all: Diagnostic[], bytes: Buffer): Diagnostic[] {
  const seen = new Set<string>();
  const first: number[] = [], rest: number[] = [];
  all.forEach((item, index) => {
    const key = `${item.severity === 'error' ? 'e' : 'w'}|${codeOf(item, bytes) || item.message.slice(0, 40)}`;
    if (seen.has(key)) rest.push(index); else { seen.add(key); first.push(index); }
  });
  const rank = (index: number) => all[index]!.severity === 'error' ? 0 : 1;
  const order = [...first.filter(index => rank(index) === 0), ...first.filter(index => rank(index) === 1),
    ...rest.filter(index => rank(index) === 0), ...rest.filter(index => rank(index) === 1)];
  const chosen: number[] = [];
  let used = 0;
  for (const index of order) {
    const size = Buffer.byteLength(renderDiagnostic(all[index]!)) + 1;
    if (chosen.length > 0 && used + size > DIAGNOSTIC_BUDGET_BYTES) continue;
    chosen.push(index); used += size;
  }
  return chosen.sort((left, right) => left - right).map(index => all[index]!);
}

export function renderChannelSummary(summary: ChannelSummary): string {
  const lines = summary.diagnostics.map(renderDiagnostic);
  if (summary.diagnosticsOmitted > 0 && summary.diagnostics.length > 0) {
    if (summary.fileCounts) lines.push(`by file: ${summary.fileCounts.map(([file, count]) => `${file}=${count}`).join(' ')}${summary.filesOmitted ? ` (+${summary.filesOmitted} files)` : ''}`);
    lines.push(`+${summary.diagnosticsOmitted} more diagnostics, recover with the receipt`);
  }
  // Counters print only when non-zero; an all-zero channel adds no status line.
  const counters = ([['omittedBytes', summary.omittedBytes], ['diagnosticsOmitted', summary.diagnosticsOmitted],
    ['excerptsClipped', summary.excerptsClipped], ['unparsedBytes', summary.unparsedBytes]] as const)
    .filter(([, value]) => value !== 0).map(([name, value]) => `${name}=${value}`);
  if (summary.unavailable) counters.push(`unavailable=${summary.unavailable}`);
  const text = summary.informational ?? summary.smallText ?? '';
  return text + (text && !text.endsWith('\n') ? '\n' : '') +
    (lines.length ? lines.join('\n') + '\n' : '') + (counters.length ? counters.join(' ') + '\n' : '');
}
