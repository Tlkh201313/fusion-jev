import { constants } from 'node:fs';
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { accessSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FusionExecutor, type ExecutionResult } from './executor.js';
import type { Candidate, RouteRequest, RouteResult, ToolDefinition } from './types.js';
import { classifyHit, compileSafeRegex, globMatcher, rankHits, UnsafePatternError, type GrepHit } from './grep.js';
import { OutlineBuilder, findSymbols, outlineLanguage, type OutlineSymbol } from './outline.js';

export interface WorkspaceRequest { task: string; path?: string; query?: string; maxResults?: number }
export interface WorkspaceResult { route: RouteResult; execution?: ExecutionResult }
export interface WorkspaceRouter { route(request: RouteRequest, signal?: AbortSignal): Promise<RouteResult> }
export interface GrepOptions { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; mode?: 'content' | 'files' | 'count'; contextLines?: number; topK?: number }
export interface SearchOptions { contextLines?: number; offset?: number }
export type WorkspaceErrorCode = 'INVALID_REQUEST' | 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_A_FILE' | 'NOT_A_DIRECTORY' | 'NOT_TEXT_FILE' | 'FILE_TOO_LARGE' | 'GIT_FAILED' | 'CANCELLED' | 'TIMEOUT';
export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string) { super(message); this.name = 'WorkspaceError'; }
}

const MAX_READ_BYTES = 64 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 1000;
const MAX_READ_LINES = 300;
const MAX_LINE_CHARS = 2000;
const MAX_READ_CHARS = 24_000;
const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GIT_BYTES = 32 * 1024;
const MAX_STREAM_SCAN_BYTES = 64 * 1024 * 1024;
const LARGE_FILE_SCAN_BYTES = 1024 * 1024;
const TOTAL_LARGE_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_GREP_PATTERN = 200;
const MAX_GREP_LINE = 2000;
const MAX_GREP_HITS = 4000;
const GREP_DEADLINE_MS = 10_000;
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', '.next', '.ssh', '.aws', '.azure', '.gnupg', '.codex', '.npmrc', '.superpowers']);

function excludedName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED.has(lower) || lower === '.env' || lower.startsWith('.env.');
}

// Keep the caller's scope literal while applying the same exclusions as file
// traversal. A global --literal-pathspecs flag would disable exclusion magic.
function gitPathspecs(scope: string): string[] {
  return [`:(literal)${scope}`, ...[...EXCLUDED, '.env', '.env.*'].flatMap(name =>
    [`:(exclude,icase,glob)**/${name}`, `:(exclude,icase,glob)**/${name}/**`])];
}

function gitExecutable(root: string): string {
  const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const approvedRoot = normalize(root);
  const inWorkspace = (path: string) => normalize(path) === approvedRoot || normalize(path).startsWith(approvedRoot + sep);
  // Resolve fixed inspection commands ourselves: Windows otherwise searches the
  // workspace before PATH, and either platform can honor relative PATH entries.
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    try {
      const directory = realpathSync.native(entry);
      if (inWorkspace(directory)) continue;
      const executable = realpathSync.native(join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
      if (inWorkspace(executable) || !statSync(executable).isFile()) continue;
      if (process.platform !== 'win32') accessSync(executable, constants.X_OK);
      return executable;
    } catch { /* Ignore unavailable PATH candidates without running them. */ }
  }
  throw new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace');
}

function gitRepositoryArgs(root: string): string[] {
  if (realpathSync.native(root) !== root) throw new WorkspaceError('INVALID_PATH', 'Workspace root changed during access');
  // Locate the physical worktree marker, including linked-worktree .git files.
  // Pin both Git boundaries so core.worktree and inherited Git environment cannot
  // redirect reads. Keep the outer worktree for a workspace bound to a subfolder;
  // Git then retains that folder's path prefix against the existing index.
  for (let directory = root; ; directory = dirname(directory)) {
    const marker = join(directory, '.git');
    if (existsSync(marker)) {
      try {
        const info = lstatSync(marker);
        if (info.isSymbolicLink()) throw new Error('redirected marker');
        if (info.isDirectory()) {
          if (realpathSync.native(marker) !== marker) throw new Error('redirected metadata');
        } else {
          const readPointer = (path: string) => {
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid metadata pointer');
            return readFileSync(path, 'utf8').trim();
          };
          const pointer = /^gitdir: (.+)$/.exec(readPointer(marker))?.[1];
          if (!pointer) throw new Error('invalid Git marker');
          const metadata = realpathSync.native(resolve(directory, pointer));
          if (!metadata.startsWith(directory + sep)) {
            // A legitimate linked worktree identifies this exact marker from its
            // admin directory, which is a child of the common repo's worktrees.
            const backlink = realpathSync.native(resolve(metadata, readPointer(join(metadata, 'gitdir'))));
            const common = realpathSync.native(resolve(metadata, readPointer(join(metadata, 'commondir'))));
            if (backlink !== marker || dirname(metadata) !== realpathSync.native(join(common, 'worktrees')))
              throw new Error('unrelated Git metadata');
          }
        }
        return [`--git-dir=${marker}`, `--work-tree=${directory}`];
      } catch { throw new WorkspaceError('GIT_FAILED', 'Git metadata is outside the approved repository or unsupported'); }
    }
    if (dirname(directory) === directory) throw new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace');
  }
}

const definitions: ToolDefinition[] = [
  { name: 'list_files', description: 'List names and types in a workspace directory.', readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['path', 'maxResults'], additionalProperties: false } },
  { name: 'read_file', description: 'Read up to 64 KiB of a UTF-8 workspace file.', readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'search_text', description: 'Search workspace text files for a literal phrase.', readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' },
      maxResults: { type: 'integer', minimum: 1, maximum: 50 } },
    required: ['path', 'query', 'maxResults'], additionalProperties: false } },
  ...(['git_status', 'git_diff', 'git_log'] as const).map(name => ({
    name, description: name === 'git_status' ? 'Show Git working tree status.'
      : name === 'git_diff' ? 'Show unstaged Git changes.' : 'Show the five latest Git commits.',
    readOnly: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })),
];

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): WorkspaceError {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? new WorkspaceError('TIMEOUT', 'Workspace action timed out')
    : new WorkspaceError('CANCELLED', 'Workspace action cancelled');
}

function decodeText(buffer: Buffer, truncated: boolean): string {
  if (buffer.includes(0)) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not UTF-8 text');
  for (let end = buffer.length, attempts = 0; attempts < 4; end--, attempts++) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)); }
    catch { if (!truncated || attempts === 3) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text'); }
  }
  throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text');
}

function* textLines(content: string): Generator<string> {
  let start = 0;
  for (const match of content.matchAll(/\r\n|\n|\r/g)) {
    yield content.slice(start, match.index);
    start = match.index + match[0].length;
  }
  if (start < content.length) yield content.slice(start);
}

/** Verify the opened file's identity and canonical target before running `body`, and that it did not change meanwhile. */
async function withVerifiedFile<T>(root: string, target: string, signal: AbortSignal, body: (file: FileHandle, size: number) => Promise<T>): Promise<T> {
  checkSignal(signal);
  // root is the previously approved canonical directory, not fresh authority
  // to follow a junction installed after workspace path resolution.
  const canonicalRoot = resolve(root);
  const verifyRoot = async () => {
    if (await realpath(root) !== canonicalRoot) throw new WorkspaceError('INVALID_PATH', 'Workspace root changed during access');
  };
  await verifyRoot();
  const before = await realpath(target);
  const allowed = (path: string) => {
    if (path !== canonicalRoot && !path.startsWith(canonicalRoot + sep)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    if (relative(canonicalRoot, path).split(/[\\/]/).some(excludedName)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
  };
  allowed(before);
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await verifyRoot();
    const after = await realpath(target);
    allowed(after);
    const opened = await file.stat();
    let current = await stat(after);
    // Node 22.12 on Windows reports dev 0 for path-based stat but the volume serial for a handle; re-open the path so
    // both sides come from handles instead of skipping the device comparison.
    if (process.platform === 'win32' && opened.dev !== current.dev && (opened.dev === 0 || current.dev === 0)) {
      const reopened = await open(after, constants.O_RDONLY);
      try { current = await reopened.stat(); } finally { await reopened.close(); }
    }
    if (before !== after || !opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino)
      throw new WorkspaceError('INVALID_PATH', 'Workspace path changed during access');
    const value = await body(file, opened.size);
    const final = await file.stat();
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs)
      throw new WorkspaceError('INVALID_PATH', 'Workspace file changed during access');
    checkSignal(signal);
    return value;
  } finally { await file.close(); }
}

/** Verify the opened file's identity and canonical target before reading any bytes. */
export async function safeWorkspaceBytes(root: string, target: string, signal: AbortSignal = AbortSignal.timeout(15000), maxBytes = MAX_READ_FILE_BYTES): Promise<Buffer> {
  return withVerifiedFile(root, target, signal, async (file, size) => {
    if (size > maxBytes) throw new WorkspaceError('FILE_TOO_LARGE', 'File exceeds the read limit');
    const chunks: Buffer[] = [];
    const sample = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total <= maxBytes) {
      checkSignal(signal);
      const { bytesRead } = await file.read(sample, 0, Math.min(sample.length, maxBytes + 1 - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new WorkspaceError('FILE_TOO_LARGE', 'File exceeds the read limit');
      chunks.push(Buffer.from(sample.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  });
}

export interface LineStreamStats { size: number; bytes: number; lines: number; complete: boolean; stopped: boolean }

/**
 * Stream a verified UTF-8 file as lines without holding it in memory. `onLine` may return false to stop early.
 * Scans at most `maxBytes`; `complete` is false when that budget ended the scan before end of file.
 * Lines longer than 8 KiB are truncated (only their start is delivered).
 */
export async function streamWorkspaceLines(root: string, target: string, signal: AbortSignal,
  onLine: (text: string, number: number) => boolean | void, maxBytes = MAX_STREAM_SCAN_BYTES): Promise<LineStreamStats> {
  return withVerifiedFile(root, target, signal, async (file, size) => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.alloc(64 * 1024);
    let carry = '', pendingReturn = false, number = 0, total = 0, stopped = false, eof = false;
    const emit = (text: string) => { number++; if (onLine(text, number) === false) stopped = true; };
    try {
      while (!stopped && total < maxBytes) {
        checkSignal(signal);
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxBytes - total), null);
        if (!bytesRead) { eof = true; break; }
        total += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        if (chunk.includes(0)) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not UTF-8 text');
        let text = decoder.decode(chunk, { stream: true });
        if (pendingReturn) { pendingReturn = false; if (text.startsWith('\n')) text = text.slice(1); }
        const breaks = /\r\n|\n|\r/g;
        let start = 0;
        for (let match = breaks.exec(text); match && !stopped; match = breaks.exec(text)) {
          const line = carry + text.slice(start, match.index);
          carry = '';
          start = match.index + match[0].length;
          emit(line);
          if (match[0] === '\r' && start === text.length) pendingReturn = true;
        }
        if (!stopped) carry = (carry + text.slice(start)).slice(0, 8192);
      }
      if (!stopped && (eof || total >= size)) {
        const tail = carry + decoder.decode();
        eof = true;
        if (tail) emit(tail);
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof TypeError) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text');
      throw error;
    }
    return { size, bytes: total, lines: number, complete: eof && !stopped || (!stopped && total >= size), stopped };
  });
}

export class WorkspaceService {
  readonly root: string;
  private readonly router: WorkspaceRouter;
  private readonly executor: FusionExecutor;
  private readonly sourceByResult = new WeakMap<object, Map<string, Buffer>>();
  private readonly gitByResult = new WeakMap<object, Buffer>();

  constructor(root: string, router: WorkspaceRouter) {
    try {
      this.root = realpathSync.native(root);
      if (!statSync(this.root).isDirectory()) throw new Error('not a directory');
    }
    catch { throw new WorkspaceError('INVALID_PATH', 'Workspace root is unavailable'); }
    this.router = router;
    this.executor = new FusionExecutor({ handlers: [
      { definition: definitions[0]!, handle: async (args, signal) => this.listFiles(args.path as string, args.maxResults as number, signal) },
      { definition: definitions[1]!, handle: async (args, signal) => this.readFile(args.path as string, signal) },
      { definition: definitions[2]!, handle: async (args, signal) => this.searchText(args.path as string, args.query as string, args.maxResults as number, signal) },
      { definition: definitions[3]!, handle: async (_args, signal) => this.gitCommand('status', signal) },
      { definition: definitions[4]!, handle: async (_args, signal) => this.gitCommand('diff', signal) },
      { definition: definitions[5]!, handle: async (_args, signal) => this.gitCommand('log', signal) },
    ], maxSteps: 1, totalTimeoutMs: 15000 });
  }

  async run(input: WorkspaceRequest, signal?: AbortSignal): Promise<WorkspaceResult> {
    if (!input.task?.trim() || (input.query !== undefined && !input.query.trim()))
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid workspace request');
    const maxResults = input.maxResults ?? 50;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 50)
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid workspace request');
    const path = input.path ?? '.';
    const target = await this.resolvePath(path);
    const kind = await stat(target);
    const candidates: Candidate[] = [];
    if (kind.isDirectory()) candidates.push({ id: 'list', tool: 'list_files', arguments: { path, maxResults } });
    if (kind.isFile()) candidates.push({ id: 'read', tool: 'read_file', arguments: { path } });
    if (input.query && (kind.isDirectory() || kind.isFile()))
      candidates.push({ id: 'search', tool: 'search_text', arguments: { path, query: input.query, maxResults } });
    if (this.hasGitRepository()) {
      candidates.push({ id: 'git-status', tool: 'git_status', arguments: {} },
        { id: 'git-diff', tool: 'git_diff', arguments: {} },
        { id: 'git-log', tool: 'git_log', arguments: {} });
    }
    if (!candidates.length) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    const route = await this.router.route({ task: input.task, tools: definitions, candidates, cache: false }, signal);
    if (route.decision.status !== 'selected') return { route };
    const selected = candidates.some(candidate => candidate.id === route.decision.candidateId
      && candidate.tool === route.decision.call.tool && isDeepStrictEqual(candidate.arguments, route.decision.call.arguments));
    if (!selected || route.decision.source !== 'jev') return { route, execution: { status: 'invalid' } };
    return { route, execution: await this.executor.execute(route.decision, signal) };
  }

  async list(path = '.', maxResults = 30, offset = 0, signal: AbortSignal = AbortSignal.timeout(15000)) {
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 50 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid listing limit or offset');
    return this.listFiles(path, maxResults, signal, offset);
  }

  async read(path: string, startLine = 1, maxLines = 120, signal: AbortSignal = AbortSignal.timeout(15000)) {
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > MAX_READ_LINES)
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid line range');
    return this.readLines(path, startLine, maxLines, MAX_READ_CHARS, signal);
  }

  /** Capture the complete allowed file before excerpt rendering. */
  async snapshot(path: string, signal: AbortSignal = AbortSignal.timeout(15000)): Promise<{ path: string; bytes: Buffer; originalBytes: number }> {
    checkSignal(signal);
    const target = await this.resolvePath(path);
    if (!(await stat(target)).isFile()) throw new WorkspaceError('NOT_A_FILE', 'Path is not a file');
    const bytes = await safeWorkspaceBytes(this.root, target, signal);
    return { path: this.outputPath(target), bytes, originalBytes: bytes.length };
  }

  /** Canonical, allowed relative path and kind for callers planning fixed reads. */
  async resolveScope(path = '.'): Promise<{ path: string; kind: 'file' | 'directory' }> {
    const target = await this.resolvePath(path);
    const info = await stat(target);
    if (!info.isFile() && !info.isDirectory()) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace scope');
    return { path: this.outputPath(target), kind: info.isFile() ? 'file' : 'directory' };
  }

  /** Source bytes attached to the result that rendered them, never a later reread. */
  sourceCaptures(result: object): Array<{ path: string; bytes: Buffer; originalBytes: number }> {
    return [...(this.sourceByResult.get(result) ?? new Map())].map(([path, bytes]) => ({ path, bytes, originalBytes: bytes.length }));
  }

  gitCapture(result: object): Buffer | undefined { return this.gitByResult.get(result); }

  /** One bounded source scan for overview extraction, without rereading the file for each page. */
  async readOverview(path: string, signal: AbortSignal = AbortSignal.timeout(15000)) {
    return this.readLines(path, 1, 600, 64_000, signal);
  }

  private async readLines(path: string, startLine: number, maxLines: number, maxChars: number, signal: AbortSignal) {
    checkSignal(signal);
    const target = await this.resolvePath(path);
    const info = await stat(target);
    if (!info.isFile()) throw new WorkspaceError('NOT_A_FILE', 'Path is not a file');
    const lines: Array<{ number: number; text: string }> = [];
    let chars = 0;
    let nextLine: number | null = null;
    let shortenedLines = false;
    // Returns false once the requested window is full so a streaming caller can stop reading.
    const take = (line: string, number: number): boolean => {
      if (number < startLine) return true;
      if (lines.length >= maxLines || chars >= maxChars) { nextLine = number; return false; }
      const text = line.slice(0, Math.min(MAX_LINE_CHARS, maxChars - chars));
      if (text.length < line.length) shortenedLines = true;
      lines.push({ number, text });
      chars += text.length;
      return true;
    };
    if (info.size > MAX_READ_FILE_BYTES) {
      // Oversize files stream just the requested window; the receipt is derived from the rendered lines.
      const stats = await streamWorkspaceLines(this.root, target, signal, (line, number) => take(line, number));
      if (nextLine === null && !stats.complete) {
        if (!lines.length) throw new WorkspaceError('FILE_TOO_LARGE', 'Start line is beyond the 64 MiB scan budget');
        shortenedLines = true;
      }
      checkSignal(signal);
      return { path: this.outputPath(target), startLine, lines, nextLine, shortenedLines, streamed: true as const,
        sha256: createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex') };
    }
    const raw = await safeWorkspaceBytes(this.root, target, signal);
    let content: string;
    try {
      if (raw.includes(0)) throw new Error('binary');
      content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch { throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text'); }
    let number = 0;
    for (const line of textLines(content)) {
      checkSignal(signal);
      number++;
      if (!take(line, number)) break;
    }
    checkSignal(signal);
    const result = { path: this.outputPath(target), startLine, lines, nextLine, shortenedLines,
      sha256: createHash('sha256').update(raw).digest('hex') };
    this.sourceByResult.set(result, new Map([[result.path, raw]]));
    return result;
  }

  /** Language-aware symbol table with line ranges; any size up to the 64 MiB scan budget. */
  async outline(path: string, signal: AbortSignal = AbortSignal.timeout(15000)) {
    checkSignal(signal);
    const target = await this.resolvePath(path);
    const info = await stat(target);
    if (!info.isFile()) throw new WorkspaceError('NOT_A_FILE', 'Path is not a file');
    const output = this.outputPath(target);
    const language = outlineLanguage(output);
    if (!language) throw new WorkspaceError('INVALID_REQUEST', 'No outline support for this file type; use read or grep');
    const builder = new OutlineBuilder(language);
    let raw: Buffer | undefined;
    let complete = true;
    let sha256: string;
    if (info.size <= MAX_READ_FILE_BYTES) {
      raw = await safeWorkspaceBytes(this.root, target, signal);
      let content: string;
      try {
        if (raw.includes(0)) throw new Error('binary');
        content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch { throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text'); }
      let number = 0;
      for (const line of textLines(content)) { checkSignal(signal); builder.push(line, ++number); }
      sha256 = createHash('sha256').update(raw).digest('hex');
    } else {
      const stats = await streamWorkspaceLines(this.root, target, signal, (line, number) => { builder.push(line, number); });
      complete = stats.complete;
      sha256 = createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex');
    }
    const outline = builder.finish();
    const result = { op: 'outline' as const, path: output, language, symbols: outline.symbols, totalLines: outline.totalLines,
      complete, streamed: !raw, sha256 };
    if (raw) this.sourceByResult.set(result, new Map([[output, raw]]));
    return result;
  }

  /** Source lines of one named symbol (plus context), resolved through the regex outline. */
  async symbol(path: string, name: string, contextLines = 0, signal: AbortSignal = AbortSignal.timeout(15000)) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || !Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 20)
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid symbol name or context');
    const outline = await this.outline(path, signal);
    const matches = findSymbols(outline.symbols, name);
    if (!matches.length) {
      const needle = name.trim().toLowerCase();
      const similar = outline.symbols.filter(sym => sym.name.toLowerCase().includes(needle)).slice(0, 8)
        .map(sym => `${sym.parent ? `${sym.parent}.` : ''}${sym.name} ${sym.startLine}-${sym.endLine}`);
      throw new WorkspaceError('NOT_FOUND', `Symbol not found: ${name.trim().slice(0, 80)}.${similar.length ? ` Similar: ${similar.join(', ')}.` : ' Use outline to list symbols.'}`);
    }
    const best = matches[0]!;
    const first = Math.max(1, best.startLine - contextLines);
    const span = best.endLine - best.startLine + 1 + contextLines * 2;
    const read = await this.readLines(path, first, Math.min(MAX_READ_LINES, span), MAX_READ_CHARS, signal);
    const describe = (sym: OutlineSymbol) => ({ name: sym.parent ? `${sym.parent}.${sym.name}` : sym.name, kind: sym.kind,
      startLine: sym.startLine, endLine: sym.endLine });
    const result = { ...read, op: 'symbol' as const, symbol: { ...describe(best), approx: Boolean(best.approx), contextLines },
      others: matches.slice(1, 9).map(describe), moreOthers: Math.max(0, matches.length - 9) };
    const captured = this.sourceByResult.get(read);
    if (captured) this.sourceByResult.set(result, captured);
    return result;
  }

  async search(query: string | string[], path = '.', maxResults = 20, signal: AbortSignal = AbortSignal.timeout(15000), options: SearchOptions = {}) {
    const queries = Array.isArray(query) ? query : [query];
    if (!queries.length || queries.length > 8 || queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 256)
      || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 50
      || !Number.isSafeInteger(options.offset ?? 0) || (options.offset ?? 0) < 0 || (options.offset ?? 0) > 10000
      || !Number.isSafeInteger(options.contextLines ?? 0) || (options.contextLines ?? 0) < 0 || (options.contextLines ?? 0) > 3)
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid search query or maxResults');
    return this.searchText(path, query, maxResults, signal, options);
  }

  async git(command: 'status' | 'diff' | 'log', signal: AbortSignal = AbortSignal.timeout(15000), options: { staged?: boolean; path?: string } = {}) {
    if (!['status', 'diff', 'log'].includes(command)) throw new WorkspaceError('INVALID_REQUEST', 'Unknown Git action');
    if (options.staged && command !== 'diff') throw new WorkspaceError('INVALID_REQUEST', 'staged applies only to Git diff');
    const path = options.path ? await this.resolveGitScope(options.path) : '.';
    return this.gitCommand(command, signal, { staged: options.staged, path });
  }

  /** Git history can refer to deleted paths; validate their nearest surviving parent. */
  async resolveGitScope(input: string): Promise<string> {
    if (!input || isAbsolute(input) || input.includes('\0') || input.split(/[\\/]/).some(excludedName))
      throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    const target = resolve(this.root, input);
    if (target !== this.root && !target.startsWith(this.root + sep)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    for (let ancestor = target; ; ancestor = dirname(ancestor)) {
      try {
        const actual = await realpath(ancestor);
        if (actual !== this.root && !actual.startsWith(this.root + sep) || relative(this.root, actual).split(/[\\/]/).some(excludedName))
          throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
        return this.outputPath(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async resolvePath(input: string): Promise<string> {
    if (!input || isAbsolute(input) || input.includes('\0') || input.split(/[\\/]/).some(excludedName))
      throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    const target = resolve(this.root, input);
    if (target !== this.root && !target.startsWith(this.root + sep)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    let actual: string;
    try { actual = await realpath(target); } catch { throw new WorkspaceError('NOT_FOUND', 'Workspace path not found'); }
    if (actual !== this.root && !actual.startsWith(this.root + sep)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    if (relative(this.root, actual).split(/[\\/]/).some(excludedName)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    return actual;
  }

  private outputPath(path: string): string { return relative(this.root, path).replaceAll('\\', '/') || '.'; }

  private hasGitRepository(): boolean {
    for (let directory = this.root; ; directory = dirname(directory)) {
      if (existsSync(join(directory, '.git'))) return true;
      if (dirname(directory) === directory) return false;
    }
  }

  private async listFiles(path: string, maxResults: number, signal: AbortSignal, offset = 0) {
    checkSignal(signal);
    const target = await this.resolvePath(path);
    if (!(await stat(target)).isDirectory()) throw new WorkspaceError('NOT_A_DIRECTORY', 'Path is not a directory');
    const visible = (await readdir(target, { withFileTypes: true }))
      .filter(entry => !excludedName(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));
    const pageLimit = offset < 10000 ? Math.min(maxResults, 10000 - offset) : maxResults;
    const entries = visible.slice(offset, offset + pageLimit)
      .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
    checkSignal(signal);
    const hasMore = offset + entries.length < visible.length;
    const nextOffset = hasMore && offset < 10000 ? offset + entries.length : null;
    return { path: this.outputPath(target), entries, nextOffset, truncated: hasMore };
  }

  private async readFile(path: string, signal: AbortSignal) {
    checkSignal(signal);
    const target = await this.resolvePath(path);
    const buffer = await safeWorkspaceBytes(this.root, target, signal);
    const truncated = buffer.length > MAX_READ_BYTES;
    const content = decodeText(buffer.subarray(0, MAX_READ_BYTES), truncated);
    return { path: this.outputPath(target), content, truncated };
  }

  private async searchText(path: string, query: string | string[], maxResults: number, signal: AbortSignal, options: SearchOptions = {}) {
    checkSignal(signal);
    const queries = [...new Set(Array.isArray(query) ? query : [query])];
    const offset = options.offset ?? 0;
    const contextLines = options.contextLines ?? 0;
    const pageLimit = offset < 10000 ? Math.min(maxResults, 10000 - offset) : maxResults;
    const start = await this.resolvePath(path);
    const queue = [start];
    const inventory = (await stat(start)).isDirectory() ? await this.gitSearchInventory(signal) : null;
    const allowed = inventory ? new Set(inventory) : undefined;
    const directories = new Set<string>();
    for (const file of inventory ?? []) {
      let directory = dirname(file).replaceAll('\\', '/');
      while (directory !== '.') { directories.add(directory); directory = dirname(directory).replaceAll('\\', '/'); }
    }
    const matches: Array<{ path: string; line: number; text: string; shortened?: boolean; context?: Array<{ line: number; text: string; shortened?: boolean }> }> = [];
    const sourceBytes = new Map<string, Buffer>();
    let filesScanned = 0;
    let omittedEntries = false;
    let skippedFiles = 0;
    let partialFiles = 0;
    let largeBudget = TOTAL_LARGE_SCAN_BYTES;
    const partialPaths: string[] = [];
    const uncaptured: string[] = [];
    let matchedLines = 0;
    let hasMore = false;
    let visited = 0;
    const snippet = (line: string) => {
      const positions = queries.map(q => line.indexOf(q)).filter(p => p >= 0);
      const position = positions.length ? Math.min(...positions) : 0;
      const begin = Math.max(0, position - 80);
      return { text: line.slice(begin, begin + 500), ...(begin > 0 || line.length > begin + 500 ? { shortened: true } : {}) };
    };
    while (queue.length && filesScanned < MAX_SEARCH_FILES && visited < 4000 && !hasMore) {
      checkSignal(signal);
      visited++;
      const current = queue.shift()!;
      let info;
      try {
        // Recheck descendants: a directory can be replaced by a symlink after enumeration.
        await this.resolvePath(this.outputPath(current));
        info = await stat(current);
      } catch { skippedFiles++; continue; }
      if (info.isDirectory()) {
        let entries;
        try { entries = (await readdir(current, { withFileTypes: true }))
          .filter(entry => !excludedName(entry.name) && !entry.isSymbolicLink()
            && (!allowed || (entry.isDirectory() ? directories : allowed).has(this.outputPath(join(current, entry.name)))))
          .sort((a, b) => a.name.localeCompare(b.name)); }
        catch { skippedFiles++; continue; }
        const room = Math.max(0, MAX_SEARCH_FILES - queue.length);
        if (entries.length > room) omittedEntries = true;
        for (const entry of entries.slice(0, room)) queue.push(join(current, entry.name));
        continue;
      }
      if (!info.isFile()) continue;
      let lines: string[];
      let raw: Buffer | undefined;
      if (info.size > MAX_SEARCH_FILE_BYTES) {
        // Large files are scanned up to a byte budget and reported instead of silently skipped.
        if (largeBudget <= 0) { skippedFiles++; continue; }
        filesScanned++;
        lines = [];
        try {
          const stats = await streamWorkspaceLines(this.root, current, signal, line => { lines.push(line); }, Math.min(LARGE_FILE_SCAN_BYTES, largeBudget));
          largeBudget -= stats.bytes;
          if (!stats.complete) { partialFiles++; if (partialPaths.length < 5) partialPaths.push(this.outputPath(current)); }
        } catch (error) {
          if (error instanceof WorkspaceError && (error.code === 'CANCELLED' || error.code === 'TIMEOUT')) throw error;
          filesScanned--; skippedFiles++; continue;
        }
      } else {
        filesScanned++;
        try { raw = await safeWorkspaceBytes(this.root, current, signal, MAX_SEARCH_FILE_BYTES); lines = decodeText(raw, false).split(/\r\n|\n|\r/); }
        catch { skippedFiles++; continue; }
      }
      for (const [index, line] of lines.entries()) {
        if (!queries.some(q => line.includes(q))) continue;
        if (matchedLines++ < offset) continue;
        if (matches.length >= pageLimit) { hasMore = true; break; }
        const context = contextLines ? lines.slice(Math.max(0, index - contextLines), index + contextLines + 1)
          .map((text, i) => ({ line: Math.max(0, index - contextLines) + i + 1, ...snippet(text) })) : undefined;
        const outputPath = this.outputPath(current);
        matches.push({ path: outputPath, line: index + 1, ...snippet(line), ...(context ? { context } : {}) });
        if (raw) sourceBytes.set(outputPath, raw); else if (!uncaptured.includes(outputPath)) uncaptured.push(outputPath);
      }
    }
    checkSignal(signal);
    const scanLimited = omittedEntries || queue.length > 0 && !hasMore || hasMore && offset === 10000;
    const result = { query, matches, filesScanned, skippedFiles, scanLimited, ignoreRules: inventory ? 'git' : 'builtin',
      nextOffset: hasMore && offset < 10000 ? offset + matches.length : null,
      truncated: hasMore || scanLimited || skippedFiles > 0 || partialFiles > 0,
      ...(partialFiles ? { partialFiles, partialPaths } : {}), ...(uncaptured.length ? { uncaptured } : {}) };
    this.sourceByResult.set(result, sourceBytes);
    return result;
  }

  /**
   * Regex search over the same file universe as `search` (Git-aware, secrets and build output excluded).
   * Hits are ranked (definitions and whole-word matches first, then spread across files). Large files are
   * scanned up to a byte budget and reported; nothing is skipped silently.
   */
  async grep(options: GrepOptions, signal: AbortSignal = AbortSignal.timeout(15000)) {
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
    checkSignal(signal);
    const deadline = Date.now() + GREP_DEADLINE_MS;
    const start = await this.resolvePath(options.path ?? '.');
    const walk = await this.collectFiles(start, signal, wanted);
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
      const output = this.outputPath(file);
      let lines: string[];
      let raw: Buffer | undefined;
      try {
        const info = await stat(file);
        if (info.size > MAX_SEARCH_FILE_BYTES) {
          if (largeBudget <= 0) { skippedFiles++; if (failedPaths.length < 5) failedPaths.push(`${output} (scan budget)`); continue; }
          lines = [];
          const stats = await streamWorkspaceLines(this.root, file, signal, line => { lines.push(line); }, Math.min(LARGE_FILE_SCAN_BYTES, largeBudget));
          largeBudget -= stats.bytes;
          uncaptured.add(output);
          if (!stats.complete) { partialFiles++; if (partialPaths.length < 5) partialPaths.push(output); }
        } else {
          raw = await safeWorkspaceBytes(this.root, file, signal, MAX_SEARCH_FILE_BYTES);
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
        try { bytes = await safeWorkspaceBytes(this.root, resolve(this.root, path), signal, MAX_SEARCH_FILE_BYTES); }
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
    this.sourceByResult.set(result, sourceBytes);
    return result;
  }

  /** Breadth-first file universe shared with search semantics: Git inventory when available, fixed exclusions always. */
  private async collectFiles(start: string, signal: AbortSignal, wanted?: (path: string) => boolean) {
    const info = await stat(start);
    if (info.isFile()) return { files: [start], scanLimited: false, skippedEntries: 0, ignoreRules: 'builtin' as const };
    const inventory = await this.gitSearchInventory(signal);
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
        await this.resolvePath(this.outputPath(current));
        entry = await stat(current);
      } catch { skippedEntries++; continue; }
      if (entry.isDirectory()) {
        let children;
        try { children = (await readdir(current, { withFileTypes: true }))
          .filter(child => !excludedName(child.name) && !child.isSymbolicLink()
            && (!allowed || (child.isDirectory() ? directories : allowed).has(this.outputPath(join(current, child.name)))))
          .sort((a, b) => a.name.localeCompare(b.name)); }
        catch { skippedEntries++; continue; }
        const room = Math.max(0, MAX_SEARCH_FILES - queue.length);
        if (children.length > room) omitted = true;
        for (const child of children.slice(0, room)) queue.push(join(current, child.name));
        continue;
      }
      if (entry.isFile() && (!wanted || wanted(this.outputPath(current)))) files.push(current);
    }
    return { files, scanLimited: omitted || queue.length > 0, skippedEntries, ignoreRules: (inventory ? 'git' : 'builtin') as 'git' | 'builtin' };
  }

  private async gitSearchInventory(signal: AbortSignal, trackedOnly = false, scope = '.'): Promise<string[] | null> {
    // Fixed, read-only Git inventory honors nested ignore rules without interpreting
    // untrusted patterns ourselves. Re-run before reuse so untracked additions are fresh.
    if (!trackedOnly && !existsSync(join(this.root, '.git'))) return null;
    checkSignal(signal);
    let executable: string;
    try { executable = gitExecutable(this.root); } catch { return null; }
    return new Promise(resolve => {
      const child = spawn(executable, [...gitRepositoryArgs(this.root), '-c', 'core.fsmonitor=false', '--no-pager', 'ls-files', '--cached', ...(trackedOnly ? [] : ['--others', '--exclude-standard']), '-z', '--', ...gitPathspecs(scope)],
        { cwd: this.root, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let bytes = 0, stopped = false, settled = false;
      const timeout = setTimeout(() => { stopped = true; child.kill(); }, 3000);
      const cancel = () => { stopped = true; child.kill(); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const finish = (code: number | null) => {
        if (settled) return; settled = true;
        clearTimeout(timeout); signal.removeEventListener('abort', cancel);
        if (code !== 0 || stopped) return resolve(null);
        const paths = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
        if (paths.length > 10_000 || paths.some(path => isAbsolute(path) || path.split(/[\\/]/).includes('..'))) return resolve(null);
        resolve([...new Set(paths)]);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { stopped = true; child.kill(); } else chunks.push(chunk);
      });
      child.once('error', () => finish(null)); child.once('close', finish);
    });
  }

  private async gitCommand(command: 'status' | 'diff' | 'log', signal: AbortSignal, options: { staged?: boolean; path?: string } = {}) {
    checkSignal(signal);
    if (command === 'diff' && !options.staged) {
      const tracked = await this.gitSearchInventory(signal, true, options.path ?? '.');
      if (!tracked) throw new WorkspaceError('GIT_FAILED', 'Git scope cannot be safely inspected within the inventory limit');
      const checked = new Set<string>();
      for (const path of tracked) {
        for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
          checkSignal(signal);
          if (checked.has(parent)) break;
          checked.add(parent);
          try {
            if (lstatSync(join(this.root, parent)).isSymbolicLink())
              throw new WorkspaceError('GIT_FAILED', 'Git scope contains an unsupported directory alias');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
    }
    const operation = command === 'status' ? ['status', '--short', '--untracked-files=normal']
      : command === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', '--submodule=short', ...(options.staged ? ['--cached'] : [])]
        : ['log', '-5', '--oneline', '--no-show-signature'];
    const args = [...gitRepositoryArgs(this.root), '-c', 'core.fsmonitor=false', '--no-pager', ...operation, '--', ...gitPathspecs(options.path ?? '.')];
    const executable = gitExecutable(this.root);
    let output: { text: string; truncated: boolean; bytes: Buffer };
    try { output = await new Promise<{ text: string; truncated: boolean; bytes: Buffer }>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: this.root, windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
      timeout.unref();
      const abort = () => child.kill();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const finish = (error?: WorkspaceError) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(abortError(signal));
        else if (error || timedOut) reject(error ?? new WorkspaceError('TIMEOUT', 'Git command timed out'));
        else { const bytes = Buffer.concat(chunks); resolve({ text: bytes.toString('utf8'), truncated, bytes }); }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = MAX_GIT_BYTES - bytes;
        if (room > 0) { chunks.push(chunk.subarray(0, room)); bytes += Math.min(room, chunk.length); }
        if (chunk.length > room) { truncated = true; clearTimeout(timeout); child.kill(); }
      });
      child.stderr.resume();
      child.once('error', () => finish(new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace')));
      child.once('close', code => finish(code === 0 || truncated ? undefined : new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace')));
    }); } catch (error) {
      if (command === 'log' && error instanceof WorkspaceError && error.code === 'GIT_FAILED') {
        await this.gitCommand('status', signal);
        const empty = { command: 'git log', argv: [executable, ...args], text: '', truncated: false };
        this.gitByResult.set(empty, Buffer.alloc(0));
        return empty;
      }
      throw error;
    }
    const result = { command: `git ${command}${options.staged ? ' --cached' : ''}`, argv: [executable, ...args], text: output.text, truncated: output.truncated };
    this.gitByResult.set(result, output.bytes);
    return result;
  }
}
