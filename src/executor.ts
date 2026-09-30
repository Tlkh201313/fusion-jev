import type { FusionRouter } from './router.js';
import type { Decision, JsonObject, JsonValue, RouteRequest, RouteResult, ToolCall, ToolDefinition } from './types.js';
import { compileTools, validateCall } from './validation.js';

export interface RegisteredHandler {
  definition: ToolDefinition;
  handle(arguments_: JsonObject, signal: AbortSignal): Promise<JsonValue>;
}

export type AuthorizeWrite = (call: ToolCall, signal: AbortSignal) => Promise<boolean>;
export type ExecutionResult =
  | { status: 'executed'; output: JsonValue }
  | { status: 'denied' | 'invalid' | 'failed' | 'cancelled' | 'timeout' };
export interface WorkflowStep { route: RouteResult; execution?: ExecutionResult }
export interface WorkflowResult {
  status: 'completed' | 'escalate' | 'denied' | 'invalid' | 'failed' | 'cancelled' | 'timeout' | 'step_limit';
  steps: WorkflowStep[];
}

export class FusionExecutor {
  private readonly handlers = new Map<string, RegisteredHandler>();
  private readonly router?: FusionRouter;
  private readonly authorizeWrite?: AuthorizeWrite;
  private readonly maxSteps: number;
  private readonly totalTimeoutMs: number;

  constructor(options: {
    handlers: RegisteredHandler[];
    router?: FusionRouter;
    authorizeWrite?: AuthorizeWrite;
    maxSteps?: number;
    totalTimeoutMs?: number;
  }) {
    const definitions = options.handlers.map(h => h.definition);
    if (options.handlers.length === 0 || compileTools(definitions)?.size !== options.handlers.length)
      throw new Error('Invalid trusted handler registry');
    this.maxSteps = options.maxSteps ?? 8;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || !Number.isSafeInteger(this.totalTimeoutMs) || this.totalTimeoutMs < 1)
      throw new Error('Invalid executor limits');
    for (const handler of options.handlers) {
      if (typeof handler.handle !== 'function') throw new Error('Invalid trusted handler registry');
      this.handlers.set(handler.definition.name, { definition: structuredClone(handler.definition), handle: handler.handle });
    }
    this.router = options.router;
    this.authorizeWrite = options.authorizeWrite;
  }

  async execute(decision: Decision, signal?: AbortSignal): Promise<ExecutionResult> {
    const scope = deadlineSignal(this.totalTimeoutMs, signal);
    try { return await this.executeWithSignal(decision, scope.signal, () => scope.reason()); }
    finally { scope.close(); }
  }

  async runWorkflow(
    next: (history: readonly WorkflowStep[]) => RouteRequest | null | Promise<RouteRequest | null>,
    signal?: AbortSignal,
  ): Promise<WorkflowResult> {
    if (!this.router) throw new Error('Workflow requires a router');
    const scope = deadlineSignal(this.totalTimeoutMs, signal);
    const steps: WorkflowStep[] = [];
    try {
      for (let index = 0; index < this.maxSteps; index++) {
        if (scope.signal.aborted) return { status: scope.reason(), steps };
        let request: RouteRequest | null;
        try { request = await interruptible(Promise.resolve(next(steps)), scope.signal); }
        catch { return { status: scope.signal.aborted ? scope.reason() : 'failed', steps }; }
        if (request === null) return { status: 'completed', steps };
        const route = await this.router.route(request, scope.signal);
        const step: WorkflowStep = { route };
        steps.push(step);
        if (scope.signal.aborted) return { status: scope.reason(), steps };
        if (route.decision.status !== 'selected') return { status: route.decision.status === 'invalid' ? 'invalid' : 'escalate', steps };
        const execution = await this.executeWithSignal(route.decision, scope.signal, () => scope.reason());
        step.execution = execution;
        if (execution.status !== 'executed') return { status: execution.status, steps };
      }
      return { status: 'step_limit', steps };
    } finally { scope.close(); }
  }

  private async executeWithSignal(decision: Decision, signal: AbortSignal, abortStatus: () => 'cancelled' | 'timeout'): Promise<ExecutionResult> {
    if (signal.aborted) return { status: abortStatus() };
    if (decision.status !== 'selected') return { status: 'invalid' };
    const handler = this.handlers.get(decision.call.tool);
    if (!handler || !validateCall(decision.call, [handler.definition])) return { status: 'invalid' };
    const call = structuredClone(decision.call);
    if (handler.definition.readOnly !== true) {
      if (!this.authorizeWrite) return { status: 'denied' };
      try {
        const authorized = await interruptible(this.authorizeWrite(structuredClone(call), signal), signal);
        if (!authorized) return { status: 'denied' };
      } catch { return { status: signal.aborted ? abortStatus() : 'denied' }; }
    }
    if (signal.aborted) return { status: abortStatus() };
    if (!validateCall(call, [handler.definition])) return { status: 'invalid' };
    try {
      const output = await interruptible(handler.handle(call.arguments, signal), signal);
      return signal.aborted ? { status: abortStatus() } : { status: 'executed', output };
    } catch { return { status: signal.aborted ? abortStatus() : 'failed' }; }
  }
}

function deadlineSignal(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal; reason: () => 'cancelled' | 'timeout'; close: () => void;
} {
  const controller = new AbortController();
  let reason: 'cancelled' | 'timeout' = 'timeout';
  const onAbort = () => { reason = 'cancelled'; controller.abort(); };
  external?.addEventListener('abort', onAbort, { once: true });
  if (external?.aborted) onAbort();
  const timer = setTimeout(() => { if (!controller.signal.aborted) { reason = 'timeout'; controller.abort(); } }, timeoutMs);
  return { signal: controller.signal, reason: () => reason,
    close: () => { clearTimeout(timer); external?.removeEventListener('abort', onAbort); } };
}

function interruptible<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
