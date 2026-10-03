import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { discoverChecks, parseDiagnostics, type CheckSuggestion } from './diagnostics.js';
import type { EvidenceStore } from './evidence.js';
import { LIMITS } from './limits.js';
import type { Candidate, ProviderFailureCategory, ReasonCode, RouteRequest, RoutingService, UsageRecord } from './types.js';
import { WorkspaceError, type WorkspaceService } from './workspace.js';

export interface AssistRequest {
  task: string; root?: string; scope?: string; continuation?: string; evidenceIds?: string[];
  maxActions?: number; maxJevCalls?: number;
}
export interface AssistResult {
  status: 'evidence' | 'continue' | 'escalate';
  stopReason: 'sufficient' | 'stalled' | 'deadline' | 'action_limit' | 'jev_limit' | 'host_action' | 'provider_unavailable' | 'choice_declined' | 'invalid_selection';
  routingReason?: ReasonCode;
  failureCategory?: ProviderFailureCategory;
  actions: Array<{ kind: string; evidenceId?: string; summary: string }>;
  evidenceIds: string[];
  continuation?: string;
  hostAction?: { kind: 'command' | 'web_search' | 'browser' | 'docs'; instruction: string; argv?: string[];
    cwd?: string; recipeId?: string; sourcePath?: string; sourceSha256?: string; requiresApproval?: boolean;
    execution?: { program: string; argv: string[] } };
  telemetry: { hostVisibleBytes: number; jevCalls: number; providerTokens: number | null; cacheHits: number;
    escalations: number; latencyMs: number; costUsd: number | null };
}

type Action = { id: string; kind: 'list' | 'read' | 'search' | 'git_status' | 'git_diff' | 'git_log';
  path?: string; query?: string; offset?: number; startLine?: number; staged?: boolean; description: string };
type State = {
  id: string; root: string; scope: string; task: string; createdAt: number; expiresAt: number; deadlineAt: number; activeMs: number;
  maxActions: number; maxJevCalls: number; jevCalls: number; cacheHits: number; escalations: number;
  providerTokens: number | null; actions: AssistResult['actions']; evidenceIds: string[];
  seen: Set<string>; pending?: Action; evidenceQueue: Array<{ id: string; startByte: number }>;
  knownEvidence: Set<string>; checkManifests?: string[]; checkIndex?: number; checks: CheckSuggestion[];
  checkSources?: Array<{ path: string; content: string }>; hostActionIssued?: boolean;
  expectedResearchTool?: 'host_search' | 'host_browser' | 'host_docs';
  commandCarry?: { id: string; bytes: Buffer; startByte: number; dropping: boolean; omittedLongLines: number };
  routingReason?: ReasonCode; failureCategory?: ProviderFailureCategory;
};
const ACTION_LIMIT = 6;
const JEV_LIMIT = 2;
const DEADLINE_MS = 20_000;
const TTL_MS = LIMITS.receiptTtlMs;
const MAX_STATES = 128;
const MAX_DIAGNOSTIC_LINE_BYTES = LIMITS.diagnosticLineBytes;
const manifestNames = ['package.json', 'pyproject.toml', 'pytest.ini', 'Cargo.toml', 'go.mod', 'CMakeLists.txt', 'Makefile'];

function boundedLimit(value: number | undefined, cap: number): number {
  if (value === undefined) return cap;
  if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new WorkspaceError('INVALID_REQUEST', 'Invalid assist budget');
  return value;
}

function fileMention(task: string): string | undefined {
  const match = /(?:^|[\s`'"(])((?:[\w.-]+[\\/])*[\w.-]+\.[\w.-]+)(?=$|[\s`'",):])/u.exec(task);
  return match?.[1]?.replaceAll('\\', '/');
}

function searchPhrase(task: string): string | undefined {
  if (!/\b(?:search|find|locate)\b/i.test(task)) return undefined;
  return /["'`]([^"'`]{1,256})["'`]/.exec(task)?.[1]
    ?? /^\s*(?:find|locate|search(?: for)?)\s+(?:(?:the )?(?:definition|references?|uses?|config(?:uration)?|tests?)\s+(?:of|to|for)\s+)?([A-Za-z_$][\w$.-]{0,255})\s*$/i.exec(task)?.[1];
}

function gitIntent(task: string): Action | undefined {
  const match = /^(?:(?:show|inspect|read|summarize)\s+)?(?:git\s+(status|diff|log)\b|(?:working tree status|(?:un)?staged diff|recent commits)\b)/i.exec(task.trim());
  if (!match) return undefined;
  const kind = match[1] ?? (/diff/i.test(match[0]) ? 'diff' : /commit/i.test(match[0]) ? 'log' : 'status');
  return { id: `git_${kind}`, kind: `git_${kind}` as Action['kind'],
    ...(kind === 'diff' ? { staged: /\bstaged\b/i.test(task) } : {}), description: `Read fixed git ${kind}` };
}

function hostResearch(task: string): AssistResult['hostAction'] | undefined {
  if (/\b(?:web(?!\.[\w-])|online|latest|current news|search the internet)\b/i.test(task))
    return { kind: 'web_search', instruction: 'Search the web in the host and import attributed findings as evidence.' };
  if (/\b(?:browser|browse|open (?:the )?url)\b/i.test(task))
    return { kind: 'browser', instruction: 'Open the requested page in the host browser and import attributed findings as evidence.' };
  if (/\b(?:docs(?!\.[\w-])|documentation|api reference)\b/i.test(task))
    return { kind: 'docs', instruction: 'Read the relevant documentation in the host and import attributed findings as evidence.' };
  return undefined;
}

export class AssistanceService {
  private readonly states = new Map<string, State>();
  constructor(private readonly workspace: WorkspaceService, private readonly router: RoutingService,
    private readonly evidence: EvidenceStore, private readonly clock: () => number = Date.now) {}

  private result(state: State, status: AssistResult['status'], stopReason: AssistResult['stopReason'],
    startedAt: number, hostAction?: AssistResult['hostAction']): AssistResult {
    state.activeMs += Math.max(0, this.clock() - startedAt);
    if (status === 'escalate') state.escalations++;
    if (hostAction) {
      state.hostActionIssued = true;
      if (hostAction.kind === 'web_search') state.expectedResearchTool = 'host_search';
      else if (hostAction.kind === 'browser') state.expectedResearchTool = 'host_browser';
      else if (hostAction.kind === 'docs') state.expectedResearchTool = 'host_docs';
    }
    const continuation = status === 'continue' ? state.id : undefined;
    const visible = { status, stopReason, actions: state.actions.map(action => ({ ...action })), evidenceIds: [...state.evidenceIds],
      ...(continuation ? { continuation } : {}), ...(hostAction ? { hostAction } : {}),
      ...(state.routingReason ? { routingReason: state.routingReason } : {}),
      ...(state.failureCategory ? { failureCategory: state.failureCategory } : {}) };
    const output: AssistResult = { ...visible, telemetry: {
      hostVisibleBytes: 0, jevCalls: state.jevCalls,
      providerTokens: state.providerTokens, cacheHits: state.cacheHits,
      escalations: state.escalations, latencyMs: Math.max(0, this.clock() - state.createdAt), costUsd: null,
    } };
    for (let count = 0; count < 4; count++) {
      const bytes = Buffer.byteLength(JSON.stringify(output));
      if (bytes === output.telemetry.hostVisibleBytes) break;
      output.telemetry.hostVisibleBytes = bytes;
    }
    return output;
  }

  private remember(state: State): void {
    this.states.delete(state.id);
    this.states.set(state.id, state);
    while (this.states.size > MAX_STATES) this.states.delete(this.states.keys().next().value!);
  }

  private async stateFor(request: AssistRequest): Promise<State | null> {
    if (!request.task?.trim() || request.task.length > 4000) throw new WorkspaceError('INVALID_REQUEST', 'Invalid assist task');
    if (request.root !== undefined) {
      if (!isAbsolute(request.root)) throw new WorkspaceError('INVALID_PATH', 'root must be absolute');
      let canonical: string;
      try { canonical = realpathSync.native(request.root); } catch { throw new WorkspaceError('INVALID_PATH', 'Workspace root is unavailable'); }
      if (canonical !== this.workspace.root) throw new WorkspaceError('INVALID_PATH', 'root does not match this workspace');
    }
    const scope = gitIntent(request.task) ? await this.workspace.resolveGitScope(request.scope ?? '.')
      : (await this.workspace.resolveScope(request.scope ?? '.')).path;
    const now = this.clock();
    if (request.continuation) {
      const previous = this.states.get(request.continuation);
      if (!previous || previous.expiresAt <= now) { this.states.delete(request.continuation); return null; }
      if (previous.root !== this.workspace.root || previous.scope !== scope || previous.task !== request.task.trim()
        || request.maxActions !== undefined && request.maxActions !== previous.maxActions
        || request.maxJevCalls !== undefined && request.maxJevCalls !== previous.maxJevCalls) return null;
      previous.deadlineAt = now + Math.max(0, DEADLINE_MS - previous.activeMs);
      return previous;
    }
    const state: State = { id: randomUUID(), root: this.workspace.root, scope, task: request.task.trim(),
      createdAt: now, expiresAt: now + TTL_MS, deadlineAt: now + DEADLINE_MS, activeMs: 0,
      maxActions: boundedLimit(request.maxActions, ACTION_LIMIT), maxJevCalls: boundedLimit(request.maxJevCalls, JEV_LIMIT),
      jevCalls: 0, cacheHits: 0, escalations: 0, providerTokens: null, actions: [], evidenceIds: [], seen: new Set(),
      evidenceQueue: [], knownEvidence: new Set(), checks: [] };
    this.remember(state);
    return state;
  }

  private async catalog(state: State, signal: AbortSignal): Promise<Action[]> {
    const intendedGit = gitIntent(state.task);
    if (intendedGit) return [{ ...intendedGit, path: state.scope }];
    const scope = await this.workspace.resolveScope(state.scope);
    const mention = fileMention(state.task);
    if (mention) {
      try {
        const file = await this.workspace.resolveScope(mention);
        if (file.kind === 'file' && (scope.path === '.' || file.path === scope.path || file.path.startsWith(scope.path + '/')))
          return [{ id: `read:${file.path}`, kind: 'read', path: file.path, description: `Read ${file.path}` }];
      } catch { /* A mention is not authorization or evidence of a real file. */ }
    }
    if (scope.kind === 'file') return [{ id: `read:${scope.path}`, kind: 'read', path: scope.path, description: `Read ${scope.path}` }];
    const query = searchPhrase(state.task);
    if (query) return [{ id: `search:${scope.path}:${query}`, kind: 'search', path: scope.path, query, description: `Search ${scope.path} for a literal phrase` }];
    const git = /\bgit\s+(status|diff|log)\b|\b(?:working tree status|(?:un)?staged diff|recent commits)\b/i.exec(state.task);
    if (git) {
      const kind = git[1] ?? (/diff/i.test(git[0]) ? 'diff' : /commit/i.test(git[0]) ? 'log' : 'status');
      return [{ id: `git_${kind}`, kind: `git_${kind}` as Action['kind'], path: scope.path,
        ...(kind === 'diff' ? { staged: /\bstaged\b/i.test(state.task) } : {}), description: `Read fixed git ${kind}` }];
    }
    if (/\b(?:list|ls|show files|show directory)\b/i.test(state.task))
      return [{ id: `list:${scope.path}`, kind: 'list', path: scope.path, description: `List ${scope.path}` }];
    const entries = await this.workspace.list(scope.path, 30, 0, signal);
    const candidates: Action[] = [{ id: `list:${scope.path}`, kind: 'list', path: scope.path, description: `List ${scope.path}` }];
    for (const entry of entries.entries.filter(item => item.type === 'file').slice(0, 8)) {
      const path = scope.path === '.' ? entry.name : `${scope.path}/${entry.name}`;
      candidates.push({ id: `read:${path}`, kind: 'read', path, description: `Read ${path}` });
    }
    return candidates;
  }

  private async select(state: State, candidates: Action[], signal?: AbortSignal): Promise<Action | 'provider_unavailable' | 'jev_limit' | 'choice_declined' | 'invalid_selection'> {
    if (candidates.length === 1) return candidates[0]!;
    if (state.jevCalls >= state.maxJevCalls) return 'jev_limit';
    const ids = candidates.map(action => action.id);
    const routeRequest: RouteRequest = { task: state.task, strategy: 'jev-only', cache: false,
      tools: [{ name: 'assist_action', description: 'Select one preconstructed workspace read action.', readOnly: true,
        inputSchema: { type: 'object', properties: { id: { enum: ids } }, required: ['id'], additionalProperties: false } }],
      candidates: candidates.map(action => ({ id: action.id, tool: 'assist_action', arguments: { id: action.id }, description: action.description } satisfies Candidate)),
    };
    state.jevCalls++;
    let routed;
    try { routed = await this.router.route(routeRequest, signal); } catch { return 'provider_unavailable'; }
    if (routed.usage.length && routed.usage.every((usage: UsageRecord) => !usage.estimated))
      state.providerTokens = (state.providerTokens ?? 0) + routed.usage.reduce((sum: number, usage: UsageRecord) => sum + usage.inputTokens + usage.outputTokens, 0);
    if (routed.decision.reuse === 'cache') state.cacheHits++;
    const decision = routed.decision;
    if (decision.status !== 'selected') {
      state.routingReason = decision.reason;
      state.failureCategory = decision.failureCategory;
      return ['provider_error', 'circuit_open', 'timeout', 'cancelled'].includes(decision.reason) ? 'provider_unavailable'
        : ['invalid_response', 'invalid_candidate', 'invalid_request', 'invalid_schema'].includes(decision.reason) ? 'invalid_selection' : 'choice_declined';
    }
    if (decision.source !== 'jev') { state.routingReason = 'invalid_response'; return 'invalid_selection'; }
    const selected = candidates.find(action => action.id === decision.candidateId);
    if (!selected || decision.call.tool !== 'assist_action' || !isDeepStrictEqual(decision.call.arguments, { id: selected.id })) {
      state.routingReason = 'invalid_response'; return 'invalid_selection';
    }
    return selected;
  }

  private async capture(state: State, action: Action, result: object, text: string): Promise<boolean> {
    const sources = this.workspace.sourceCaptures(result);
    const receiptIds: string[] = [];
    let unavailable = false;
    try {
      if (sources.length) {
        for (const source of sources) {
          try {
            receiptIds.push(this.evidence.capture({ source: { kind: 'workspace', root: state.root, path: source.path },
              bytes: source.bytes, originalBytes: source.originalBytes }).id);
          } catch { unavailable = true; }
        }
      } else {
        const gitBytes = this.workspace.gitCapture(result);
        const source = action.kind.startsWith('git_')
          ? { kind: 'command' as const, cwd: state.root, argv: 'argv' in result ? result.argv as string[] : ['git', action.kind.slice(4)], channel: 'stdout' as const }
          : { kind: 'derived_workspace' as const, root: state.root, path: action.path ?? '.',
            operation: action.kind === 'list' ? 'list' as const : 'search' as const,
            ...(action.query ? { query: action.query } : {}) };
        receiptIds.push(this.evidence.capture({ source,
          bytes: gitBytes ?? Buffer.from(text), originalBytes: 'truncated' in result && result.truncated ? null : undefined,
          truncated: 'truncated' in result && result.truncated === true }).id);
      }
    } catch { unavailable = true; }
    for (const id of receiptIds) if (!state.evidenceIds.includes(id)) state.evidenceIds.push(id);
    state.actions.push({ kind: action.kind, ...(receiptIds[0] ? { evidenceId: receiptIds[0] } : {}),
      summary: unavailable || !receiptIds.length ? `${text.slice(0, 1400)} Evidence capture incomplete or unavailable; inspect with host tools.` : text.slice(0, 1800) });
    return !unavailable && receiptIds.length > 0;
  }

  private async discoverOneManifest(state: State, signal: AbortSignal): Promise<'done' | 'more' | 'unavailable'> {
    if (!state.checkManifests) {
      state.checkManifests = [];
      const scope = await this.workspace.resolveScope(state.scope);
      const directory = scope.kind === 'file' ? dirname(scope.path).replaceAll('\\', '/') : scope.path;
      for (const name of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'package-lock.json', ...manifestNames]) {
        const path = directory === '.' ? name : `${directory}/${name}`;
        try { if ((await this.workspace.resolveScope(path)).kind === 'file') state.checkManifests.push(path); }
        catch { /* No such allowed manifest. */ }
      }
      state.checkIndex = 0;
    }
    const names = state.checkManifests;
    const index = state.checkIndex!;
    if (index >= names.length) return 'done';
    const name = names[index]!;
    state.checkIndex = index + 1;
    let receiptId: string | undefined;
    let suggestions: CheckSuggestion[] = [];
    try {
      const snapshot = await this.workspace.snapshot(name, signal);
      receiptId = this.evidence.capture({ source: { kind: 'workspace', root: state.root, path: snapshot.path },
        bytes: snapshot.bytes, originalBytes: snapshot.originalBytes }).id;
      state.checkSources ??= [];
      state.checkSources.push({ path: name, content: snapshot.bytes.toString('utf8') });
      const previousIds = new Set(state.checks.map(check => check.id));
      state.checks = discoverChecks(state.root, state.checkSources);
      suggestions = state.checks.filter(check => !previousIds.has(check.id));
      state.evidenceIds.push(receiptId);
    } catch { /* The action remains counted and the missing receipt is explicit. */ }
    const remaining = names.length - state.checkIndex;
    state.actions.push({ kind: 'discover_checks', ...(receiptId ? { evidenceId: receiptId } : {}),
      summary: receiptId ? `${name}: ${suggestions.map(check => `${check.argv.join(' ')} = ${JSON.stringify(check.argv)}`).join('; ') || 'no check suggestions'}; ${remaining} uninspected manifest(s); none executed.`
        : `${name}: manifest read or evidence capture unavailable; ${remaining} uninspected manifest(s).` });
    if (!receiptId) return 'unavailable';
    return remaining ? 'more' : 'done';
  }

  private async execute(state: State, action: Action, signal: AbortSignal): Promise<'evidence' | 'continue' | 'stalled'> {
    const fingerprint = JSON.stringify(action);
    if (state.seen.has(fingerprint)) return 'stalled';
    state.seen.add(fingerprint);
    let result: Awaited<ReturnType<WorkspaceService['list']>> | Awaited<ReturnType<WorkspaceService['read']>>
      | Awaited<ReturnType<WorkspaceService['search']>> | Awaited<ReturnType<WorkspaceService['git']>>;
    try {
      if (action.kind === 'list') result = await this.workspace.list(action.path, 30, action.offset ?? 0, signal);
      else if (action.kind === 'read') result = await this.workspace.read(action.path!, action.startLine ?? 1, 120, signal);
      else if (action.kind === 'search') result = await this.workspace.search(action.query!, action.path, 20, signal, { offset: action.offset });
      else result = await this.workspace.git(action.kind.slice(4) as 'status' | 'diff' | 'log', signal, action);
    } catch (error) {
      state.actions.push({ kind: action.kind, summary: error instanceof WorkspaceError ? `${error.code}: ${error.message}` : 'Workspace action failed.' });
      return 'stalled';
    }
    const summary = 'entries' in result ? `${result.path}/ ${result.entries.map(item => item.name).join(', ') || '(empty)'}`
      : 'lines' in result ? `${result.path}: ${result.lines.map(line => `${line.number}: ${line.text}`).join('\n')}`
      : 'matches' in result ? `matches=${result.matches.length} scanLimited=${result.scanLimited} skippedFiles=${result.skippedFiles} truncated=${result.truncated} nextOffset=${result.nextOffset ?? 'none'}\n${result.matches.map(hit => `${hit.path}:${hit.line}: ${hit.text}`).join('\n')}`
      : `${result.command}: ${result.text || '(no output)'}${result.truncated ? ' [truncated]' : ''}`;
    if (!(await this.capture(state, action, result, summary))) return 'stalled';
    if ('entries' in result && result.nextOffset !== null) state.pending = { ...action, offset: result.nextOffset };
    else if ('lines' in result && result.nextLine !== null) state.pending = { ...action, startLine: result.nextLine };
    else if ('matches' in result && result.nextOffset !== null) state.pending = { ...action, offset: result.nextOffset };
    else state.pending = undefined;
    if ('matches' in result && (result.scanLimited || result.skippedFiles > 0 || result.truncated && result.nextOffset === null)) {
      state.pending = undefined;
      state.actions.at(-1)!.summary += '\nSearch incomplete; narrow the scope with host tools.';
      return 'stalled';
    }
    if ('matches' in result && !result.matches.length) return 'stalled';
    return state.pending ? 'continue' : 'evidence';
  }

  private async suppliedEvidence(state: State, ids: string[], startedAt: number): Promise<AssistResult | undefined> {
    for (const id of ids) if (!state.knownEvidence.has(id)) {
      state.knownEvidence.add(id);
      state.evidenceQueue.push({ id, startByte: 0 });
    }
    const item = state.evidenceQueue.shift();
    if (!item) return undefined;
    const page = await this.evidence.expand({ id: item.id, startByte: item.startByte, maxBytes: LIMITS.pageBytes });
    if (page.status !== 'ok' && page.status !== 'stale') {
      state.actions.push({ kind: 'read_imported', summary: `Evidence ${item.id} unavailable (${page.status}); ${state.evidenceQueue.length} unprocessed evidence ID(s).` });
      return this.result(state, 'escalate', 'stalled', startedAt);
    }
    if (state.expectedResearchTool && (page.receipt.source.kind !== 'research'
      || page.receipt.source.sourceTool !== state.expectedResearchTool)) {
      const actual = page.receipt.source.kind === 'research' ? page.receipt.source.sourceTool : page.receipt.source.kind;
      state.actions.push({ kind: 'read_imported', summary: `Evidence ${item.id} source ${actual} does not match pending ${state.expectedResearchTool} research; host must supply an attributed matching receipt.` });
      return this.result(state, 'escalate', 'stalled', startedAt);
    }
    if (!state.evidenceIds.includes(item.id)) state.evidenceIds.push(item.id);
    const incomplete = page.nextByte !== null || page.receipt.truncated || page.status === 'stale';
    const paging = `startByte=${page.startByte} nextByte=${page.nextByte ?? 'none'} truncated=${page.receipt.truncated} status=${page.status}`;
    if (page.nextByte !== null) state.evidenceQueue.unshift({ id: item.id, startByte: page.nextByte });
    let summary: string;
    let kind: string;
    if (page.receipt.source.kind === 'command') {
      kind = 'parse_log';
      const { diagnostics, deferredBytes, omittedLongLines } = this.parseCommandPage(state, item.id,
        Buffer.from(page.dataBase64, 'base64'), page.startByte, page.nextByte !== null);
      const visible = diagnostics.slice(0, 8).map(diagnostic => ({ ...diagnostic,
        message: diagnostic.message.slice(0, 240) }));
      summary = `${diagnostics.length} source-linked diagnostic observations: ${JSON.stringify(visible)}; omitted=${Math.max(0, diagnostics.length - visible.length)}; deferredBytes=${deferredBytes} omittedLongLines=${omittedLongLines}; ${paging}. Host judges outcome.`;
    } else if (page.receipt.source.kind === 'research') {
      kind = 'read_imported';
      const source = page.receipt.source;
      summary = `Imported untrusted research from ${JSON.stringify(source.url)}${source.title ? ` title=${JSON.stringify(source.title)}` : ''} sourceTool=${source.sourceTool}; ${paging}.`;
    } else {
      kind = 'read';
      summary = `Existing ${page.receipt.source.kind} evidence ${item.id}; ${paging}.`;
    }
    const remainingIds = state.evidenceQueue.filter(queued => queued.id !== item.id).length;
    if (remainingIds) summary += ` ${remainingIds} unprocessed evidence ID(s).`;
    state.actions.push({ kind, evidenceId: item.id, summary });
    if (state.evidenceQueue.length && state.actions.length >= state.maxActions)
      return this.result(state, 'escalate', 'action_limit', startedAt);
    if (page.receipt.truncated || page.status === 'stale' || page.receipt.source.kind === 'command' && state.commandCarry?.omittedLongLines && page.nextByte === null)
      return this.result(state, 'escalate', 'stalled', startedAt);
    if (state.evidenceQueue.length) return this.result(state, 'continue', 'host_action', startedAt);
    return this.result(state, incomplete ? 'escalate' : 'evidence', incomplete ? 'stalled'
      : page.receipt.source.kind === 'research' ? 'host_action' : 'sufficient', startedAt);
  }

  private parseCommandPage(state: State, id: string, pageBytes: Buffer, pageStart: number, hasNextPage: boolean) {
    let carry = state.commandCarry?.id === id ? state.commandCarry :
      { id, bytes: Buffer.alloc(0), startByte: pageStart, dropping: false, omittedLongLines: 0 };
    let bytes = pageBytes;
    let startByte = carry.bytes.length ? carry.startByte : pageStart;
    if (carry.dropping) {
      const newline = bytes.indexOf(10);
      if (newline < 0) {
        state.commandCarry = { ...carry, bytes: Buffer.alloc(0), startByte: pageStart + bytes.length };
        return { diagnostics: [] as ReturnType<typeof parseDiagnostics>, deferredBytes: 0, omittedLongLines: carry.omittedLongLines };
      }
      bytes = bytes.subarray(newline + 1);
      startByte = pageStart + newline + 1;
      carry = { ...carry, bytes: Buffer.alloc(0), dropping: false };
    }
    const combined = carry.bytes.length ? Buffer.concat([carry.bytes, bytes]) : bytes;
    let parseEnd = combined.length;
    if (hasNextPage) {
      const lastNewline = combined.lastIndexOf(10);
      parseEnd = lastNewline < 1 ? 0 : combined.lastIndexOf(10, lastNewline - 1) + 1;
    }
    let diagnostics: ReturnType<typeof parseDiagnostics> = [];
    let omittedLongLines = carry.omittedLongLines;
    const parseSegment = (from: number, to: number) => {
      if (to <= from) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(combined.subarray(from, to));
        diagnostics.push(...parseDiagnostics({ text, sourceEvidenceId: id }).map(diagnostic => ({ ...diagnostic,
          startByte: diagnostic.startByte + startByte + from, endByte: diagnostic.endByte + startByte + from })));
      } catch { omittedLongLines++; }
    };
    let segmentStart = 0;
    let lineStart = 0;
    for (let index = 0; index <= parseEnd; index++) {
      if (index !== parseEnd && combined[index] !== 10) continue;
      const lineEnd = index === parseEnd ? index : index + 1;
      if (lineEnd - lineStart > MAX_DIAGNOSTIC_LINE_BYTES) {
        parseSegment(segmentStart, lineStart);
        omittedLongLines++;
        segmentStart = lineEnd;
      }
      lineStart = lineEnd;
    }
    parseSegment(segmentStart, parseEnd);
    let deferred = combined.subarray(parseEnd);
    let deferredStart = startByte + parseEnd;
    const deferredNewline = deferred.indexOf(10);
    if (deferredNewline >= 0 && deferredNewline + 1 > MAX_DIAGNOSTIC_LINE_BYTES) {
      omittedLongLines++;
      deferred = deferred.subarray(deferredNewline + 1);
      deferredStart += deferredNewline + 1;
    }
    const logicalLineBytes = deferredNewline >= 0 && deferredNewline + 1 <= MAX_DIAGNOSTIC_LINE_BYTES
      ? deferred.length - deferredNewline - 1 : deferred.length;
    if (logicalLineBytes > MAX_DIAGNOSTIC_LINE_BYTES) {
      if (deferredNewline >= 0 && deferredNewline + 1 <= MAX_DIAGNOSTIC_LINE_BYTES)
        parseSegment(parseEnd, parseEnd + deferredNewline + 1);
      state.commandCarry = { id, bytes: Buffer.alloc(0), startByte: startByte + combined.length,
        dropping: true, omittedLongLines: omittedLongLines + 1 };
    } else state.commandCarry = { id, bytes: Buffer.from(deferred), startByte: deferredStart,
      dropping: false, omittedLongLines };
    return { diagnostics, deferredBytes: state.commandCarry.bytes.length, omittedLongLines: state.commandCarry.omittedLongLines };
  }

  async assist(request: AssistRequest, signal?: AbortSignal): Promise<AssistResult> {
    const startedAt = this.clock();
    const state = await this.stateFor(request);
    if (!state) {
      const invalid: State = { id: '', root: this.workspace.root, scope: request.scope ?? '.', task: request.task,
        createdAt: startedAt, expiresAt: startedAt, deadlineAt: startedAt, activeMs: 0, maxActions: 0, maxJevCalls: 0,
        jevCalls: 0, cacheHits: 0, escalations: 0, providerTokens: null, actions: [], evidenceIds: [], seen: new Set(),
        evidenceQueue: [], knownEvidence: new Set(), checks: [] };
      return this.result(invalid, 'escalate', 'stalled', startedAt);
    }
    if (this.clock() >= state.deadlineAt || signal?.aborted) return this.result(state, 'escalate', 'deadline', startedAt);
    const remaining = Math.max(1, state.deadlineAt - this.clock());
    const actionSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(remaining)]);
    if (state.actions.length >= state.maxActions) return this.result(state, 'escalate', 'action_limit', startedAt);
    if (request.evidenceIds?.length || state.evidenceQueue.length) {
      const supplied = await this.suppliedEvidence(state, request.evidenceIds ?? [], startedAt);
      if (this.clock() >= state.deadlineAt || actionSignal.aborted) return this.result(state, 'escalate', 'deadline', startedAt);
      if (supplied) return supplied;
    }
    if (request.continuation && state.hostActionIssued) return this.result(state, 'escalate', 'stalled', startedAt);
    const checksRequested = /\b(?:discover|list|show|find)\b.*\bchecks?\b/i.test(state.task)
      || /\b(?:run|execute)\b.*\b(?:tests?|checks?|lint|build|typecheck)\b/i.test(state.task);
    if (state.checkIndex !== undefined || checksRequested) {
      let discovery = await this.discoverOneManifest(state, actionSignal);
      while (discovery === 'more' && state.actions.length < state.maxActions && this.clock() < state.deadlineAt && !actionSignal.aborted)
        discovery = await this.discoverOneManifest(state, actionSignal);
      if (this.clock() >= state.deadlineAt || actionSignal.aborted) return this.result(state, 'escalate', 'deadline', startedAt);
      if (discovery === 'unavailable') return this.result(state, 'escalate', 'stalled', startedAt);
      if (discovery === 'more') return state.actions.length >= state.maxActions
        ? this.result(state, 'escalate', 'action_limit', startedAt)
        : this.result(state, 'continue', 'host_action', startedAt);
      if (!/\b(?:run|execute)\b/i.test(state.task)) return this.result(state, state.checks.length ? 'evidence' : 'escalate', state.checks.length ? 'sufficient' : 'stalled', startedAt);
      const wanted = /test/i.test(state.task) ? 'test' : /lint/i.test(state.task) ? 'lint' : /typecheck/i.test(state.task) ? 'typecheck' : /build/i.test(state.task) ? 'build' : 'check';
      const chosen = state.checks.find(check => check.label.toLowerCase().includes(wanted)) ?? state.checks[0];
      if (!chosen) return this.result(state, 'escalate', 'stalled', startedAt);
      const execution = { program: 'fusion-jev', argv: ['run', `--cwd=${chosen.cwd}`, '--', ...chosen.argv] };
      return this.result(state, 'continue', 'host_action', startedAt,
        { kind: 'command', instruction: `Review the discovered ${wanted} recipe and revalidate its manifest hash. Invoke the native program and exact argv below through the host execution API with its native permissions, without joining the arguments into shell text. If the host API requires shell text, apply that platform's correct quoting to each argument; the JSON is data, not an executable shell command.\nNative program: ${execution.program}\nHost argv JSON: ${JSON.stringify(execution.argv)}\nImport output evidence; host judges outcome.`,
          argv: chosen.argv, cwd: chosen.cwd, recipeId: chosen.id, sourcePath: chosen.sourcePath,
          sourceSha256: chosen.sourceSha256, requiresApproval: chosen.requiresApproval, execution });
    }
    if (request.continuation && !state.pending) return this.result(state, 'escalate', 'stalled', startedAt);
    const mention = fileMention(state.task);
    let localMention = false;
    if (mention) try {
      const file = await this.workspace.resolveScope(mention);
      localMention = file.kind === 'file' && (state.scope === '.' || file.path === state.scope || file.path.startsWith(state.scope + '/'));
    } catch { /* An unresolvable mention is not local evidence. */ }
    const scopedLocalAction = state.scope !== '.'
      && /\b(?:list|ls|read|search|find|show files|show directory)\b/i.test(state.task)
      && !/\b(?:external|online|latest|official|web|browser|browse|api documentation|api reference)\b/i.test(state.task);
    const research = localMention || scopedLocalAction ? undefined : hostResearch(state.task);
    if (research) return this.result(state, 'continue', 'host_action', startedAt, research);
    const action = state.pending ?? await this.select(state, await this.catalog(state, actionSignal), actionSignal);
    if (this.clock() >= state.deadlineAt || signal?.aborted) return this.result(state, 'escalate', 'deadline', startedAt);
    if (typeof action === 'string') return this.result(state, 'escalate', action, startedAt);
    const outcome = await this.execute(state, action, actionSignal);
    if (this.clock() >= state.deadlineAt || actionSignal.aborted) return this.result(state, 'escalate', 'deadline', startedAt);
    if (outcome === 'continue') return state.actions.length >= state.maxActions
      ? this.result(state, 'escalate', 'action_limit', startedAt)
      : this.result(state, 'continue', 'host_action', startedAt);
    return outcome === 'evidence' ? this.result(state, 'evidence', 'sufficient', startedAt)
      : this.result(state, 'escalate', 'stalled', startedAt);
  }
}
