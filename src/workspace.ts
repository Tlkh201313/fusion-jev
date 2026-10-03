/**
 * Read-only workspace service: bounded listing, line reads, literal search, regex grep, outlines and fixed Git commands
 * over one approved root, with every path canonicalized and checked against that root and the exclusion list.
 *
 * Sync fs is used only where async is impossible or pointless: the constructor (which must return a bound root) and the
 * Git helpers in workspace-git.ts, which stat a handful of metadata paths that must be verified and used without an
 * await gap. All file content access goes through the async, handle-verified readers in workspace-files.ts.
 */
import { realpathSync, statSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FusionExecutor, type ExecutionResult } from './executor.js';
import type { Candidate, RouteRequest, RouteResult, ToolDefinition } from './types.js';
import { OutlineBuilder, findSymbols, outlineLanguage, type OutlineSymbol } from './outline.js';
import {
  WorkspaceError,
  checkSignal,
  excludedName,
  hasExcludedSegment,
  isWithin,
  workspaceOutputPath,
} from './workspace-base.js';
import {
  LARGE_FILE_SCAN_BYTES,
  MAX_READ_FILE_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_FILE_BYTES,
  TOTAL_LARGE_SCAN_BYTES,
  decodeText,
  safeWorkspaceBytes,
  streamWorkspaceLines,
  textLines,
} from './workspace-files.js';
import { gitSearchInventory, hasGitRepository, resolveGitScope, runGitCommand } from './workspace-git.js';
import { runGrep, type GrepOptions } from './workspace-grep.js';

export { WorkspaceError, type WorkspaceErrorCode } from './workspace-base.js';
export { safeWorkspaceBytes, streamWorkspaceLines, type LineStreamStats } from './workspace-files.js';
export type { GrepOptions } from './workspace-grep.js';

export interface WorkspaceRequest {
  task: string;
  path?: string;
  query?: string;
  maxResults?: number;
}
export interface WorkspaceResult {
  route: RouteResult;
  execution?: ExecutionResult;
}
export interface WorkspaceRouter {
  route(request: RouteRequest, signal?: AbortSignal): Promise<RouteResult>;
}
export interface SearchOptions {
  contextLines?: number;
  offset?: number;
}

const MAX_READ_BYTES = 64 * 1024;
const MAX_READ_LINES = 300;
const MAX_LINE_CHARS = 2000;
const MAX_READ_CHARS = 24_000;

const definitions: ToolDefinition[] = [
  {
    name: 'list_files',
    description: 'List names and types in a workspace directory.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['path', 'maxResults'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read up to 64 KiB of a UTF-8 workspace file.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_text',
    description: 'Search workspace text files for a literal phrase.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        query: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['path', 'query', 'maxResults'],
      additionalProperties: false,
    },
  },
  ...(['git_status', 'git_diff', 'git_log'] as const).map((name) => ({
    name,
    description:
      name === 'git_status'
        ? 'Show Git working tree status.'
        : name === 'git_diff'
          ? 'Show unstaged Git changes.'
          : 'Show the five latest Git commits.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })),
];

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
    } catch {
      throw new WorkspaceError('INVALID_PATH', 'Workspace root is unavailable');
    }
    this.router = router;
    this.executor = new FusionExecutor({
      handlers: [
        {
          definition: definitions[0]!,
          handle: async (args, signal) => this.listFiles(args.path as string, args.maxResults as number, signal),
        },
        { definition: definitions[1]!, handle: async (args, signal) => this.readFile(args.path as string, signal) },
        {
          definition: definitions[2]!,
          handle: async (args, signal) =>
            this.searchText(args.path as string, args.query as string, args.maxResults as number, signal),
        },
        { definition: definitions[3]!, handle: async (_args, signal) => this.gitCommand('status', signal) },
        { definition: definitions[4]!, handle: async (_args, signal) => this.gitCommand('diff', signal) },
        { definition: definitions[5]!, handle: async (_args, signal) => this.gitCommand('log', signal) },
      ],
      maxSteps: 1,
      totalTimeoutMs: 15000,
    });
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
      candidates.push(
        { id: 'git-status', tool: 'git_status', arguments: {} },
        { id: 'git-diff', tool: 'git_diff', arguments: {} },
        { id: 'git-log', tool: 'git_log', arguments: {} },
      );
    }
    if (!candidates.length) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    const route = await this.router.route({ task: input.task, tools: definitions, candidates, cache: false }, signal);
    if (route.decision.status !== 'selected') return { route };
    const selected = candidates.some(
      (candidate) =>
        candidate.id === route.decision.candidateId &&
        candidate.tool === route.decision.call.tool &&
        isDeepStrictEqual(candidate.arguments, route.decision.call.arguments),
    );
    if (!selected || route.decision.source !== 'jev') return { route, execution: { status: 'invalid' } };
    return { route, execution: await this.executor.execute(route.decision, signal) };
  }

  async list(path = '.', maxResults = 30, offset = 0, signal: AbortSignal = AbortSignal.timeout(15000)) {
    if (
      !Number.isSafeInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 50 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 10000
    )
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid listing limit or offset');
    return this.listFiles(path, maxResults, signal, offset);
  }

  async read(path: string, startLine = 1, maxLines = 120, signal: AbortSignal = AbortSignal.timeout(15000)) {
    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      !Number.isSafeInteger(maxLines) ||
      maxLines < 1 ||
      maxLines > MAX_READ_LINES
    )
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid line range');
    return this.readLines(path, startLine, maxLines, MAX_READ_CHARS, signal);
  }

  /** Capture the complete allowed file before excerpt rendering. */
  async snapshot(
    path: string,
    signal: AbortSignal = AbortSignal.timeout(15000),
  ): Promise<{ path: string; bytes: Buffer; originalBytes: number }> {
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
    return [...(this.sourceByResult.get(result) ?? new Map())].map(([path, bytes]) => ({
      path,
      bytes,
      originalBytes: bytes.length,
    }));
  }

  gitCapture(result: object): Buffer | undefined {
    return this.gitByResult.get(result);
  }

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
      if (lines.length >= maxLines || chars >= maxChars) {
        nextLine = number;
        return false;
      }
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
      return {
        path: this.outputPath(target),
        startLine,
        lines,
        nextLine,
        shortenedLines,
        streamed: true as const,
        sha256: createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex'),
      };
    }
    const raw = await safeWorkspaceBytes(this.root, target, signal);
    let content: string;
    try {
      if (raw.includes(0)) throw new Error('binary');
      content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text');
    }
    let number = 0;
    for (const line of textLines(content)) {
      checkSignal(signal);
      number++;
      if (!take(line, number)) break;
    }
    checkSignal(signal);
    const result = {
      path: this.outputPath(target),
      startLine,
      lines,
      nextLine,
      shortenedLines,
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
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
    if (!language)
      throw new WorkspaceError('INVALID_REQUEST', 'No outline support for this file type; use read or grep');
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
      } catch {
        throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text');
      }
      let number = 0;
      for (const line of textLines(content)) {
        checkSignal(signal);
        builder.push(line, ++number);
      }
      sha256 = createHash('sha256').update(raw).digest('hex');
    } else {
      const stats = await streamWorkspaceLines(this.root, target, signal, (line, number) => {
        builder.push(line, number);
      });
      complete = stats.complete;
      sha256 = createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex');
    }
    const outline = builder.finish();
    const result = {
      op: 'outline' as const,
      path: output,
      language,
      symbols: outline.symbols,
      totalLines: outline.totalLines,
      complete,
      streamed: !raw,
      sha256,
    };
    if (raw) this.sourceByResult.set(result, new Map([[output, raw]]));
    return result;
  }

  /** Source lines of one named symbol (plus context), resolved through the regex outline. */
  async symbol(path: string, name: string, contextLines = 0, signal: AbortSignal = AbortSignal.timeout(15000)) {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 200 ||
      !Number.isSafeInteger(contextLines) ||
      contextLines < 0 ||
      contextLines > 20
    )
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid symbol name or context');
    const outline = await this.outline(path, signal);
    const matches = findSymbols(outline.symbols, name);
    if (!matches.length) {
      const needle = name.trim().toLowerCase();
      const similar = outline.symbols
        .filter((sym) => sym.name.toLowerCase().includes(needle))
        .slice(0, 8)
        .map((sym) => `${sym.parent ? `${sym.parent}.` : ''}${sym.name} ${sym.startLine}-${sym.endLine}`);
      throw new WorkspaceError(
        'NOT_FOUND',
        `Symbol not found: ${name.trim().slice(0, 80)}.${similar.length ? ` Similar: ${similar.join(', ')}.` : ' Use outline to list symbols.'}`,
      );
    }
    const best = matches[0]!;
    const first = Math.max(1, best.startLine - contextLines);
    const span = best.endLine - best.startLine + 1 + contextLines * 2;
    const read = await this.readLines(path, first, Math.min(MAX_READ_LINES, span), MAX_READ_CHARS, signal);
    const describe = (sym: OutlineSymbol) => ({
      name: sym.parent ? `${sym.parent}.${sym.name}` : sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
    });
    const result = {
      ...read,
      op: 'symbol' as const,
      symbol: { ...describe(best), approx: Boolean(best.approx), contextLines },
      others: matches.slice(1, 9).map(describe),
      moreOthers: Math.max(0, matches.length - 9),
    };
    const captured = this.sourceByResult.get(read);
    if (captured) this.sourceByResult.set(result, captured);
    return result;
  }

  async search(
    query: string | string[],
    path = '.',
    maxResults = 20,
    signal: AbortSignal = AbortSignal.timeout(15000),
    options: SearchOptions = {},
  ) {
    const queries = Array.isArray(query) ? query : [query];
    if (
      !queries.length ||
      queries.length > 8 ||
      queries.some((q) => typeof q !== 'string' || !q.trim() || q.length > 256) ||
      !Number.isSafeInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 50 ||
      !Number.isSafeInteger(options.offset ?? 0) ||
      (options.offset ?? 0) < 0 ||
      (options.offset ?? 0) > 10000 ||
      !Number.isSafeInteger(options.contextLines ?? 0) ||
      (options.contextLines ?? 0) < 0 ||
      (options.contextLines ?? 0) > 3
    )
      throw new WorkspaceError('INVALID_REQUEST', 'Invalid search query or maxResults');
    return this.searchText(path, query, maxResults, signal, options);
  }

  async git(
    command: 'status' | 'diff' | 'log',
    signal: AbortSignal = AbortSignal.timeout(15000),
    options: { staged?: boolean; path?: string } = {},
  ) {
    if (!['status', 'diff', 'log'].includes(command)) throw new WorkspaceError('INVALID_REQUEST', 'Unknown Git action');
    if (options.staged && command !== 'diff')
      throw new WorkspaceError('INVALID_REQUEST', 'staged applies only to Git diff');
    const path = options.path ? await this.resolveGitScope(options.path) : '.';
    return this.gitCommand(command, signal, { staged: options.staged, path });
  }

  /** Git history can refer to deleted paths; validate their nearest surviving parent. */
  async resolveGitScope(input: string): Promise<string> {
    return resolveGitScope(this.root, input);
  }

  private async resolvePath(input: string): Promise<string> {
    if (!input || isAbsolute(input) || input.includes('\0') || hasExcludedSegment(input))
      throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    const target = resolve(this.root, input);
    if (!isWithin(this.root, target)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    let actual: string;
    try {
      actual = await realpath(target);
    } catch {
      throw new WorkspaceError('NOT_FOUND', 'Workspace path not found');
    }
    if (!isWithin(this.root, actual) || hasExcludedSegment(relative(this.root, actual)))
      throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    return actual;
  }

  private outputPath(path: string): string {
    return workspaceOutputPath(this.root, path);
  }

  private hasGitRepository(): boolean {
    return hasGitRepository(this.root);
  }

  private async listFiles(path: string, maxResults: number, signal: AbortSignal, offset = 0) {
    checkSignal(signal);
    const target = await this.resolvePath(path);
    if (!(await stat(target)).isDirectory()) throw new WorkspaceError('NOT_A_DIRECTORY', 'Path is not a directory');
    const visible = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !excludedName(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));
    const pageLimit = offset < 10000 ? Math.min(maxResults, 10000 - offset) : maxResults;
    const entries = visible
      .slice(offset, offset + pageLimit)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }));
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

  private async searchText(
    path: string,
    query: string | string[],
    maxResults: number,
    signal: AbortSignal,
    options: SearchOptions = {},
  ) {
    checkSignal(signal);
    const queries = [...new Set(Array.isArray(query) ? query : [query])];
    const offset = options.offset ?? 0;
    const contextLines = options.contextLines ?? 0;
    const pageLimit = offset < 10000 ? Math.min(maxResults, 10000 - offset) : maxResults;
    const start = await this.resolvePath(path);
    const queue = [start];
    const inventory = (await stat(start)).isDirectory() ? await gitSearchInventory(this.root, signal) : null;
    const allowed = inventory ? new Set(inventory) : undefined;
    const directories = new Set<string>();
    for (const file of inventory ?? []) {
      let directory = dirname(file).replaceAll('\\', '/');
      while (directory !== '.') {
        directories.add(directory);
        directory = dirname(directory).replaceAll('\\', '/');
      }
    }
    const matches: Array<{
      path: string;
      line: number;
      text: string;
      shortened?: boolean;
      context?: Array<{ line: number; text: string; shortened?: boolean }>;
    }> = [];
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
      const positions = queries.map((q) => line.indexOf(q)).filter((p) => p >= 0);
      const position = positions.length ? Math.min(...positions) : 0;
      const begin = Math.max(0, position - 80);
      return {
        text: line.slice(begin, begin + 500),
        ...(begin > 0 || line.length > begin + 500 ? { shortened: true } : {}),
      };
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
      } catch {
        skippedFiles++;
        continue;
      }
      if (info.isDirectory()) {
        let entries;
        try {
          entries = (await readdir(current, { withFileTypes: true }))
            .filter(
              (entry) =>
                !excludedName(entry.name) &&
                !entry.isSymbolicLink() &&
                (!allowed ||
                  (entry.isDirectory() ? directories : allowed).has(this.outputPath(join(current, entry.name)))),
            )
            .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
          skippedFiles++;
          continue;
        }
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
        if (largeBudget <= 0) {
          skippedFiles++;
          continue;
        }
        filesScanned++;
        lines = [];
        try {
          const stats = await streamWorkspaceLines(
            this.root,
            current,
            signal,
            (line) => {
              lines.push(line);
            },
            Math.min(LARGE_FILE_SCAN_BYTES, largeBudget),
          );
          largeBudget -= stats.bytes;
          if (!stats.complete) {
            partialFiles++;
            if (partialPaths.length < 5) partialPaths.push(this.outputPath(current));
          }
        } catch (error) {
          if (error instanceof WorkspaceError && (error.code === 'CANCELLED' || error.code === 'TIMEOUT')) throw error;
          filesScanned--;
          skippedFiles++;
          continue;
        }
      } else {
        filesScanned++;
        try {
          raw = await safeWorkspaceBytes(this.root, current, signal, MAX_SEARCH_FILE_BYTES);
          lines = decodeText(raw, false).split(/\r\n|\n|\r/);
        } catch {
          skippedFiles++;
          continue;
        }
      }
      for (const [index, line] of lines.entries()) {
        if (!queries.some((q) => line.includes(q))) continue;
        if (matchedLines++ < offset) continue;
        if (matches.length >= pageLimit) {
          hasMore = true;
          break;
        }
        const context = contextLines
          ? lines
              .slice(Math.max(0, index - contextLines), index + contextLines + 1)
              .map((text, i) => ({ line: Math.max(0, index - contextLines) + i + 1, ...snippet(text) }))
          : undefined;
        const outputPath = this.outputPath(current);
        matches.push({ path: outputPath, line: index + 1, ...snippet(line), ...(context ? { context } : {}) });
        if (raw) sourceBytes.set(outputPath, raw);
        else if (!uncaptured.includes(outputPath)) uncaptured.push(outputPath);
      }
    }
    checkSignal(signal);
    const scanLimited = omittedEntries || (queue.length > 0 && !hasMore) || (hasMore && offset === 10000);
    const result = {
      query,
      matches,
      filesScanned,
      skippedFiles,
      scanLimited,
      ignoreRules: inventory ? 'git' : 'builtin',
      nextOffset: hasMore && offset < 10000 ? offset + matches.length : null,
      truncated: hasMore || scanLimited || skippedFiles > 0 || partialFiles > 0,
      ...(partialFiles ? { partialFiles, partialPaths } : {}),
      ...(uncaptured.length ? { uncaptured } : {}),
    };
    this.sourceByResult.set(result, sourceBytes);
    return result;
  }
  /**
   * Regex search over the same file universe as `search` (Git-aware, secrets and build output excluded).
   * Hits are ranked (definitions and whole-word matches first, then spread across files). Large files are
   * scanned up to a byte budget and reported; nothing is skipped silently.
   */
  async grep(options: GrepOptions, signal: AbortSignal = AbortSignal.timeout(15000)) {
    const { result, sourceBytes } = await runGrep(
      { root: this.root, resolvePath: (path) => this.resolvePath(path), outputPath: (path) => this.outputPath(path) },
      options,
      signal,
    );
    this.sourceByResult.set(result, sourceBytes);
    return result;
  }

  private async gitCommand(
    command: 'status' | 'diff' | 'log',
    signal: AbortSignal,
    options: { staged?: boolean; path?: string } = {},
  ) {
    const { result, bytes } = await runGitCommand(this.root, command, signal, options);
    this.gitByResult.set(result, bytes);
    return result;
  }
}

export type ListResult = Awaited<ReturnType<WorkspaceService['list']>>;
export type ReadResult = Awaited<ReturnType<WorkspaceService['read']>>;
export type SearchResult = Awaited<ReturnType<WorkspaceService['search']>>;
export type OutlineActionResult = Awaited<ReturnType<WorkspaceService['outline']>>;
export type SymbolResult = Awaited<ReturnType<WorkspaceService['symbol']>>;
export type GrepResult = Awaited<ReturnType<WorkspaceService['grep']>>;
export type GitResult = Awaited<ReturnType<WorkspaceService['git']>>;
/** Every result an inspection action can produce: `op` tags outline, symbol and grep; the rest are told apart by shape. */
export type WorkspaceActionResult =
  ListResult | ReadResult | SearchResult | OutlineActionResult | SymbolResult | GrepResult | GitResult;
