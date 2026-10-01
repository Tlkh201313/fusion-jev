import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Local, append-only record of what `fusion-jev run` captured versus what it showed the
// host. Only the program name is kept: arguments can carry secrets. Nothing leaves the machine.
export interface GainEntry { t: number; program: string; capturedBytes: number; shownBytes: number; exitCode: number | null }
export interface GainSummary {
  runs: number; capturedBytes: number; shownBytes: number;
  byProgram: Array<{ program: string; runs: number; savedBytes: number }>;
}

const MAX_LOG_BYTES = 1024 * 1024;

export function gainLogPath(cacheBase: string): string {
  return join(cacheBase, 'fusion-jev-mcp', 'gain.jsonl');
}

export function programName(argv0: string): string {
  return basename(argv0).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').slice(0, 64) || 'unknown';
}

/** Best effort: accounting never changes a command's result. */
export function recordGain(path: string, entry: GainEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, path + '.1');
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch { /* Accounting is optional. */ }
}

export function readGain(path: string): GainSummary {
  const summary: GainSummary = { runs: 0, capturedBytes: 0, shownBytes: 0, byProgram: [] };
  const programs = new Map<string, { runs: number; savedBytes: number }>();
  for (const file of [path + '.1', path]) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry: Partial<GainEntry>;
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry.program !== 'string' || !Number.isSafeInteger(entry.capturedBytes) || !Number.isSafeInteger(entry.shownBytes)) continue;
      summary.runs++;
      summary.capturedBytes += entry.capturedBytes!;
      summary.shownBytes += entry.shownBytes!;
      const program = programs.get(entry.program) ?? { runs: 0, savedBytes: 0 };
      program.runs++;
      program.savedBytes += entry.capturedBytes! - entry.shownBytes!;
      programs.set(entry.program, program);
    }
  }
  summary.byProgram = [...programs].map(([program, value]) => ({ program, ...value }))
    .sort((left, right) => right.savedBytes - left.savedBytes);
  return summary;
}

const kilo = (value: number) => Math.abs(value) >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
  : Math.abs(value) >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
const tokens = (bytes: number) => Math.round(bytes / 4);

export function formatGain(summary: GainSummary): string {
  if (!summary.runs) return 'No fusion-jev run captures recorded yet. Try: fusion-jev run -- npm test\n';
  const saved = summary.capturedBytes - summary.shownBytes;
  const percent = summary.capturedBytes ? (100 * saved / summary.capturedBytes).toFixed(1) : '0.0';
  const lines = [
    `Fusion gain on this machine (fusion-jev run, non-raw)`,
    `runs ${summary.runs}  captured ${kilo(summary.capturedBytes)}B  shown to host ${kilo(summary.shownBytes)}B  saved ${percent}%`,
    `estimated tokens kept out of context: ~${kilo(tokens(saved))} (bytes/4; recovered receipts and small outputs count against this)`,
    ...summary.byProgram.slice(0, 5).map(item => `  ${item.program.padEnd(16)} ${String(item.runs).padStart(5)} runs  ~${kilo(tokens(item.savedBytes))} tok`),
  ];
  return lines.join('\n') + '\n';
}

export function formatStatusline(summary: GainSummary): string {
  if (!summary.runs) return 'fusion ready';
  return `fusion ▾ ~${kilo(tokens(summary.capturedBytes - summary.shownBytes))} tok saved · ${summary.runs} runs`;
}
