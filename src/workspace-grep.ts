/**
 * Workspace regex search: walks the same file universe as literal search (Git-aware, secrets and build output excluded)
 * and ranks hits. The pure pattern and ranking helpers live in grep.ts.
 */
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { classifyHit, compileSafeRegex, globMatcher, rankHits, UnsafePatternError, type GrepHit } from './grep.js';
import { WorkspaceError, checkSignal, excludedName } from './workspace-base.js';
import { LARGE_FILE_SCAN_BYTES, MAX_SEARCH_FILES, MAX_SEARCH_FILE_BYTES, TOTAL_LARGE_SCAN_BYTES, decodeText, safeWorkspaceBytes, streamWorkspaceLines } from './workspace-files.js';
import { gitSearchInventory } from './workspace-git.js';

export interface GrepOptions { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; mode?: 'content' | 'files' | 'count'; contextLines?: number; topK?: number }

/** What grep needs from the workspace service; path resolution stays with the service that owns the root. */
export interface GrepHost {
  readonly root: string;
  resolvePath(input: string): Promise<string>;
  outputPath(path: string): string;
}

const MAX_GREP_LINE = 2000;
const MAX_GREP_HITS = 4000;
const GREP_DEADLINE_MS = 10_000;

/** Breadth-first file universe shared with search semantics: Git inventory when available, fixed exclusions always. */
async function collectFiles(host: GrepHost, start: string, signal: AbortSignal, wanted?: (path: string) => boolean) {
  const info = await stat(start);
  if (info.isFile()) return { files: [start], scanLimited: false, skippedEntries: 0, ignoreRules: 'builtin' as const };
  const inventory = await gitSearchInventory(host.root, signal);
  const allowed = inventory ? new Set(inventory) : undefined;
  const directories = new Set<string>();
  for (const file of inventory ?? []) {
    let directory = dirname(file).replaceAll('\\', '/');
    while (directory !== '.') { directories.add(directory); directory = dirname(directory).replaceAll('\\', '/'); }
  }
  const queue = [start];
  const files: string[] = [];
  let visited = 0, skippedEntries = 0, omitted = false;
  while (queue.length && files.length < MAX_SEARCH_FILES && visited < 4000) {
    checkSignal(signal);
    visited++;
    const current = queue.shift()!;
    let entry;
    try {
      // Recheck descendants: a directory can be replaced by a symlink after enumeration.
      await host.resolvePath(host.outputPath(current));
      entry = await stat(current);
    } catch { skippedEntries++; continue; }
    if (entry.isDirectory()) {
      let children;
      try { children = (await readdir(current, { withFileTypes: true }))
        .filter(child => !excludedName(child.name) && !child.isSymbolicLink()
          && (!allowed || (child.isDirectory() ? directories : allowed).has(host.outputPath(join(current, child.name)))))
        .sort((a, b) => a.name.localeCompare(b.name)); }
      catch { skippedEntries++; continue; }
      const room = Math.max(0, MAX_SEARCH_FILES - queue.length);
      if (children.length > room) omitted = true;
      for (const child of children.slice(0, room)) queue.push(join(current, child.name));
      continue;
    }
    if (entry.isFile() && (!wanted || wanted(host.outputPath(current)))) files.push(current);
  }
  return { files, scanLimited: omitted || queue.length > 0, skippedEntries, ignoreRules: (inventory ? 'git' : 'builtin') as 'git' | 'builtin' };
}

function validateGrepOptions(options: GrepOptions) {
  const mode = options.mode ?? 'content';
  const contextLines = options.contextLines ?? 0;
  const topK = options.topK ?? 20;
  if (typeof options.pattern !== 'string' || !['content', 'files', 'count'].includes(mode)
    || !Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 3
    || !Number.isSafeInteger(topK) || topK < 1 || topK > 50 || (options.glob !== undefined && (typeof options.glob !== 'string' || !options.glob)))
    throw new WorkspaceError('INVALID_REQUEST', 'Invalid grep request');
  let regex: RegExp;
  let wanted: ((path: string) => boolean) | undefined;
  try {
    regex = compileSafeRegex(options.pattern, options.ignoreCase === true);
    if (regex.test('')) throw new UnsafePatternError('Pattern matches the empty string');
    wanted = options.glob ? globMatcher(options.glob) : undefined;
  } catch (error) {
    if (error instanceof UnsafePatternError) throw new WorkspaceError('INVALID_REQUEST', error.message);
    throw error;
  }
  return { mode, contextLines, topK, regex, wanted };
}

/**
 * Regex search over the same file universe as `search`. Hits are ranked (definitions and whole-word matches first,
 * then spread across files). Large files are scanned up to a byte budget and reported; nothing is skipped silently.
 * Returns the result plus the exact source bytes behind the files it shows (for evidence receipts).
 */
export async function runGrep(host: GrepHost, options: GrepOptions, signal: AbortSignal) {
  const { mode, contextLines, topK, regex, wanted } = validateGrepOptions(options);
  checkSignal(signal);
  const deadline = Date.now() + GREP_DEADLINE_MS;
  const start = await host.resolvePath(options.path ?? '.');
  const walk = await collectFiles(host, start, signal, wanted);
  type Hit = GrepHit & { shortened?: boolean; context?: Array<{ line: number; text: string }> };
  const hits: Hit[] = [];
  const perFile = new Map<string, { count: number; tier: number }>();
  const retained = new Map<string, Buffer>();
  const uncaptured = new Set<string>();
  const partialPaths: string[] = [];
  const failedPaths: string[] = [];
  let retainedBytes = 0, totalMatches = 0, filesScanned = 0, skippedFiles = 0, partialFiles = 0, longLines = 0;
  let timedOut = false, capped = false, largeBudget = TOTAL_LARGE_SCAN_BYTES;
  const clip = (text: string, around = 0) => {
    const begin = Math.max(0, around - 80);
    return { text: text.slice(begin, begin + 240), shortened: begin > 0 || text.length > begin + 240 };
  };
  for (const file of walk.files) {
    checkSignal(signal);
    if (Date.now() > deadline) { timedOut = true; break; }
    const output = host.outputPath(file);
    let lines: string[];
    let raw: Buffer | undefined;
    try {
      const info = await stat(file);
      if (info.size > MAX_SEARCH_FILE_BYTES) {
        if (largeBudget <= 0) { skippedFiles++; if (failedPaths.length < 5) failedPaths.push(`${output} (scan budget)`); continue; }
        lines = [];
        const stats = await streamWorkspaceLines(host.root, file, signal, line => { lines.push(line); }, Math.min(LARGE_FILE_SCAN_BYTES, largeBudget));
        largeBudget -= stats.bytes;
        uncaptured.add(output);
        if (!stats.complete) { partialFiles++; if (partialPaths.length < 5) partialPaths.push(output); }
      } else {
        raw = await safeWorkspaceBytes(host.root, file, signal, MAX_SEARCH_FILE_BYTES);
        lines = decodeText(raw, false).split(/\r\n|\n|\r/);
      }
    } catch (error) {
      if (error instanceof WorkspaceError && (error.code === 'CANCELLED' || error.code === 'TIMEOUT')) throw error;
      skippedFiles++; if (failedPaths.length < 5) failedPaths.push(output);
      continue;
    }
    filesScanned++;
    let fileHits = 0;
    for (let index = 0; index < lines.length; index++) {
      if ((index & 1023) === 0 && Date.now() > deadline) { timedOut = true; break; }
      const full = lines[index]!;
      if (full.length > MAX_GREP_LINE) longLines++;
      const line = full.length > MAX_GREP_LINE ? full.slice(0, MAX_GREP_LINE) : full;
      const match = regex.exec(line);
      if (!match) continue;
      totalMatches++; fileHits++;
      if (hits.length >= MAX_GREP_HITS) { capped = true; continue; }
      const kind = classifyHit(line, match.index, match[0].length);
      const shown = clip(line, match.index);
      const context = contextLines && mode === 'content'
        ? lines.slice(Math.max(0, index - contextLines), index + contextLines + 1)
          .map((text, i) => ({ line: Math.max(0, index - contextLines) + i + 1, text: clip(text).text })) : undefined;
      hits.push({ path: output, line: index + 1, text: shown.text, column: match.index + 1, length: match[0].length, ...kind,
        ...(shown.shortened ? { shortened: true } : {}), ...(context ? { context } : {}) });
      const entry = perFile.get(output) ?? { count: 0, tier: 0 };
      entry.tier = Math.max(entry.tier, kind.tier);
      perFile.set(output, entry);
    }
    if (fileHits) {
      const entry = perFile.get(output) ?? { count: 0, tier: 0 };
      entry.count = fileHits; perFile.set(output, entry);
      if (raw && retainedBytes + raw.length <= 16 * 1024 * 1024) { retained.set(output, raw); retainedBytes += raw.length; }
    }
    if (timedOut) break;
  }
  checkSignal(signal);
  const files = [...perFile.entries()].map(([path, entry]) => ({ path, count: entry.count, tier: entry.tier }))
    .sort((a, b) => mode === 'count' ? b.count - a.count || (a.path < b.path ? -1 : 1)
      : b.tier - a.tier || b.count - a.count || (a.path < b.path ? -1 : 1));
  const ranked = mode === 'content' ? rankHits(hits).slice(0, topK) : [];
  const shownFiles = mode === 'content' ? [...new Set(ranked.map(hit => hit.path))] : files.slice(0, topK).map(file => file.path);
  const sourceBytes = new Map<string, Buffer>();
  for (const path of shownFiles) {
    if (uncaptured.has(path)) continue;
    let bytes = retained.get(path);
    if (!bytes) {
      try { bytes = await safeWorkspaceBytes(host.root, resolve(host.root, path), signal, MAX_SEARCH_FILE_BYTES); }
      catch (error) { if (error instanceof WorkspaceError && (error.code === 'CANCELLED' || error.code === 'TIMEOUT')) throw error; }
    }
    if (bytes) sourceBytes.set(path, bytes);
  }
  const scanLimited = walk.scanLimited || timedOut;
  const result = { op: 'grep' as const, pattern: options.pattern, mode, topK,
    matches: ranked.map(({ path, line, text, definition, exactWord, shortened, context }) =>
      ({ path, line, text, ...(definition ? { definition: true } : {}), ...(exactWord ? { exactWord: true } : {}),
        ...(shortened ? { shortened: true } : {}), ...(context ? { context } : {}) })),
    files: files.slice(0, topK).map(({ path, count }) => ({ path, count })),
    totalMatches, filesMatched: perFile.size, filesScanned, skippedFiles, partialFiles, partialPaths, failedPaths, longLines,
    scanLimited, timedOut, capped, ignoreRules: walk.ignoreRules,
    truncated: scanLimited || capped || skippedFiles > 0 || partialFiles > 0 || walk.skippedEntries > 0 || (mode === 'content' ? totalMatches > ranked.length : perFile.size > topK),
    ...(uncaptured.size && shownFiles.some(path => uncaptured.has(path)) ? { uncaptured: shownFiles.filter(path => uncaptured.has(path)) } : {}) };
  return { result, sourceBytes };
}
