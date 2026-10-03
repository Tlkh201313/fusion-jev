import type { EvidenceStore, EvidenceReceipt } from './evidence.js';
import { scanDiagnostics, type Diagnostic } from './diagnostics.js';

export interface ChannelSummary {
  diagnostics: Diagnostic[];
  diagnosticsOmitted: number;
  excerptsClipped: number;
  omittedBytes: number;
  unparsedBytes: number;
  smallText?: string;
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
    const found = scanDiagnostics({ text: decoder.decode(bytes.subarray(start, end)), sourceEvidenceId: receipt.id }, 4 - diagnostics.length);
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
  const shown = exactSmall === undefined ? diagnostics.slice(0, 4) : [];
  return { diagnostics: shown, diagnosticsOmitted: totalDiagnostics - shown.length,
    excerptsClipped: shown.filter(diagnostic => diagnostic.message.length > 200).length,
    omittedBytes: exactSmall === undefined ? bytes.length : 0, unparsedBytes,
    ...(exactSmall === undefined ? {} : { smallText: exactSmall }) };
}

export function renderChannelSummary(summary: ChannelSummary): string {
  const lines = summary.diagnostics.map(diagnostic => {
    const location = diagnostic.file ? `${diagnostic.file}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}${diagnostic.column === undefined ? '' : `:${diagnostic.column}`}: ` : '';
    return `${location}${diagnostic.severity}: ${diagnostic.message.slice(0, 200)}${diagnostic.message.length > 200 ? ' [excerpt clipped]' : ''} [${diagnostic.evidenceId}:${diagnostic.startByte}-${diagnostic.endByte}]`;
  });
  // Counters print only when non-zero; an all-zero channel adds no status line.
  const counters = ([['omittedBytes', summary.omittedBytes], ['diagnosticsOmitted', summary.diagnosticsOmitted],
    ['excerptsClipped', summary.excerptsClipped], ['unparsedBytes', summary.unparsedBytes]] as const)
    .filter(([, value]) => value !== 0).map(([name, value]) => `${name}=${value}`);
  if (summary.unavailable) counters.push(`unavailable=${summary.unavailable}`);
  const text = summary.smallText ?? '';
  return text + (text && !text.endsWith('\n') ? '\n' : '') +
    (lines.length ? lines.join('\n') + '\n' : '') + (counters.length ? counters.join(' ') + '\n' : '');
}
