import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { accessSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FusionExecutor, type ExecutionResult } from './executor.js';
import type { Candidate, RouteRequest, RouteResult, ToolDefinition } from './types.js';

export interface WorkspaceRequest { task: string; path?: string; query?: string; maxResults?: number }
export interface WorkspaceResult { route: RouteResult; execution?: ExecutionResult }
export interface WorkspaceRouter { route(request: RouteRequest, signal?: AbortSignal): Promise<RouteResult> }
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

/** Verify the opened file's identity and canonical target before reading any bytes. */
export async function safeWorkspaceBytes(root: string, target: string, signal: AbortSignal = AbortSignal.timeout(15000), maxBytes = MAX_READ_FILE_BYTES): Promise<Buffer> {
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
    if (opened.size > maxBytes) throw new WorkspaceError('FILE_TOO_LARGE', 'File exceeds the read limit');
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
    const final = await file.stat();
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs)
      throw new WorkspaceError('INVALID_PATH', 'Workspace file changed during access');
    checkSignal(signal);
    return Buffer.concat(chunks, total);
  } finally { await file.close(); }
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
    if (!(await stat(target)).isFile()) throw new WorkspaceError('NOT_A_FILE', 'Path is not a file');
    const raw = await safeWorkspaceBytes(this.root, target, signal);
    let content: string;
    try {
      if (raw.includes(0)) throw new Error('binary');
      content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch { throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text'); }
    const lines: Array<{ number: number; text: string }> = [];
    let number = 0;
    let chars = 0;
    let nextLine: number | null = null;
    let shortenedLines = false;
      for (const line of textLines(content)) {
        checkSignal(signal);
        number++;
        if (number < startLine) continue;
        if (lines.length >= maxLines || chars >= maxChars) { nextLine = number; break; }
        const text = line.slice(0, Math.min(MAX_LINE_CHARS, maxChars - chars));
        if (text.length < line.length) shortenedLines = true;
        lines.push({ number, text });
        chars += text.length;
      }
    checkSignal(signal);
    const result = { path: this.outputPath(target), startLine, lines, nextLine, shortenedLines };
    this.sourceByResult.set(result, new Map([[result.path, raw]]));
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
      if (info.size > MAX_SEARCH_FILE_BYTES) { skippedFiles++; continue; }
      filesScanned++;
      let content: string;
      let raw: Buffer;
      try {
        raw = await safeWorkspaceBytes(this.root, current, signal, MAX_SEARCH_FILE_BYTES);
        content = decodeText(raw, false);
      }
      catch { skippedFiles++; continue; }
      const lines = content.split(/\r\n|\n|\r/);
      for (const [index, line] of lines.entries()) {
        if (!queries.some(q => line.includes(q))) continue;
        if (matchedLines++ < offset) continue;
        if (matches.length >= pageLimit) { hasMore = true; break; }
        const context = contextLines ? lines.slice(Math.max(0, index - contextLines), index + contextLines + 1)
          .map((text, i) => ({ line: Math.max(0, index - contextLines) + i + 1, ...snippet(text) })) : undefined;
        const outputPath = this.outputPath(current);
        matches.push({ path: outputPath, line: index + 1, ...snippet(line), ...(context ? { context } : {}) });
        sourceBytes.set(outputPath, raw);
      }
    }
    checkSignal(signal);
    const scanLimited = omittedEntries || queue.length > 0 && !hasMore || hasMore && offset === 10000;
    const result = { query, matches, filesScanned, skippedFiles, scanLimited, ignoreRules: inventory ? 'git' : 'builtin',
      nextOffset: hasMore && offset < 10000 ? offset + matches.length : null,
      truncated: hasMore || scanLimited || skippedFiles > 0 };
    this.sourceByResult.set(result, sourceBytes);
    return result;
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
