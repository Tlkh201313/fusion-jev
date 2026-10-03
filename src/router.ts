import { ProviderError } from './errors.js';
import { LIMITS } from './limits.js';
import { ESCALATE, type BatchResult, type ChoiceAnswer, type ChoiceProvider, type Decision, type FusionConfig, type GenerativeProvider, type PreparedRequest, type ReasonCode, type RouteRequest, type RouteResult, type UsageRecord } from './types.js';
import { prepareRequest, validateCall } from './validation.js';
import { Semaphore } from './concurrency.js';

type ProviderName = 'jev' | 'gpt';
type CacheEntry = { decision: Decision; expires: number };
type Breaker = { failures: number; until: number };

function abortError(): Error { return Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
function now(): number { return Date.now(); }
function elapsed(start: number): number { return Math.max(0, now() - start); }
function copyDecision(decision: Decision): Decision { return structuredClone(decision); }
function host(reason: ReasonCode): Decision { return { status: 'escalate', source: 'host', reason }; }
function invalid(reason: ReasonCode): Decision { return { status: 'invalid', source: 'none', reason }; }

export class FusionRouter {
  private readonly config: FusionConfig;
  private readonly jev?: ChoiceProvider;
  private readonly gpt?: GenerativeProvider;
  private readonly clock: () => number;
  private readonly semaphore: Semaphore;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<RouteResult>>();
  private readonly breakers: Record<ProviderName, Breaker> = {
    jev: { failures: 0, until: 0 }, gpt: { failures: 0, until: 0 },
  };

  constructor(options: { config: FusionConfig; jev?: ChoiceProvider; gpt?: GenerativeProvider; clock?: () => number }) {
    this.config = structuredClone(options.config);
    const routing = this.config.routing;
    const probabilities = [routing.minConfidence, routing.minProbability, routing.minMargin];
    const positiveIntegers = [routing.maxCandidates, routing.maxBatchSize, routing.maxRequestBytes,
      routing.totalTimeoutMs, routing.maxConcurrency, routing.breakerThreshold, routing.breakerCooldownMs,
      this.config.jev.timeoutMs, this.config.gpt.timeoutMs];
    const nonnegativeIntegers = [routing.cacheTtlMs, routing.cacheMaxEntries];
    if (!['host', 'gpt'].includes(routing.fallback)
      || probabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1)
      || positiveIntegers.some(value => !Number.isSafeInteger(value) || value < 1)
      || nonnegativeIntegers.some(value => !Number.isSafeInteger(value) || value < 0)
      || routing.maxCandidates > LIMITS.maxCandidates) throw new Error('Invalid routing configuration');
    this.jev = options.jev;
    this.gpt = options.gpt;
    this.clock = options.clock ?? Date.now;
    this.semaphore = new Semaphore(this.config.routing.maxConcurrency);
  }

  async route(request: RouteRequest, signal?: AbortSignal): Promise<RouteResult> {
    const start = now();
    if (signal?.aborted) return { decision: host('cancelled'), usage: [], latencyMs: elapsed(start) };
    const prepared = prepareRequest(request, this.config);
    if (!prepared.request) return { decision: invalid(prepared.reason ?? 'invalid_request'), usage: [], latencyMs: elapsed(start) };
    const req = prepared.request;
    if (prepared.enumeration === 'unsupported' && req.strategy !== 'gpt-only')
      return { decision: host('unsupported_schema'), usage: [], latencyMs: elapsed(start) };
    const cacheable = request.cache !== false && req.candidates.length > 0
      && req.candidates.every(c => req.tools.find(t => t.name === c.tool)?.readOnly === true);
    const key = cacheable ? JSON.stringify(req) : undefined;
    if (key) {
      const entry = this.cache.get(key);
      if (entry && entry.expires > this.clock())
        return { decision: { ...copyDecision(entry.decision), reuse: 'cache' }, usage: [], latencyMs: elapsed(start) };
      if (entry) this.cache.delete(key);
      const pending = signal ? undefined : this.inflight.get(key);
      if (pending) {
        try {
          const result = await waitFor(pending, signal);
          return { decision: { ...copyDecision(result.decision), reuse: 'inflight' }, usage: [], latencyMs: elapsed(start) };
        } catch { return { decision: host(signal?.aborted ? 'cancelled' : 'provider_error'), usage: [], latencyMs: elapsed(start) }; }
      }
    }
    const work = this.routePrepared(req, signal);
    if (key && !signal) this.inflight.set(key, work);
    try {
      const result = await work;
      if (signal?.aborted) return { decision: host('cancelled'), usage: result.usage, latencyMs: elapsed(start) };
      if (key && result.decision.status === 'selected' && this.config.routing.cacheTtlMs > 0 && this.config.routing.cacheMaxEntries > 0) {
        this.cache.set(key, { decision: copyDecision(result.decision), expires: this.clock() + this.config.routing.cacheTtlMs });
        while (this.cache.size > this.config.routing.cacheMaxEntries) this.cache.delete(this.cache.keys().next().value!);
      }
      return { ...result, latencyMs: elapsed(start) };
    } finally { if (key && !signal) this.inflight.delete(key); }
  }

  async routeBatch(requests: RouteRequest[], signal?: AbortSignal): Promise<BatchResult> {
    const start = now();
    const deadline = start + this.config.routing.totalTimeoutMs;
    if (signal?.aborted) return { decisions: requests.map(() => host('cancelled')), usage: [], latencyMs: elapsed(start) };
    if (!Array.isArray(requests) || requests.length > this.config.routing.maxBatchSize)
      return { decisions: Array.isArray(requests) ? requests.map(() => invalid('invalid_request')) : [invalid('invalid_request')], usage: [], latencyMs: elapsed(start) };
    const prepared = requests.map(r => prepareRequest(r, this.config));
    const decisions: Decision[] = prepared.map(p => p.request ? host('no_candidates') : invalid(p.reason ?? 'invalid_request'));
    const usage: UsageRecord[] = [];
    const jevIndices = prepared.flatMap((p, index) => p.request && p.enumeration !== 'unsupported'
      && p.request.strategy !== 'gpt-only' && p.request.candidates.length > 0 ? [index] : []);
    const jevRequests = jevIndices.map(i => prepared[i]!.request!);
    if (jevRequests.length) {
      try {
        const result = await this.callProvider('jev', signal, s => this.jev!.choose(jevRequests, s), deadline);
        usage.push(...result.usage);
        if (!Array.isArray(result.answers) || result.answers.length !== jevRequests.length) {
          for (const index of jevIndices) decisions[index] = host('invalid_response');
        } else {
          for (let offset = 0; offset < jevIndices.length; offset++) {
            const index = jevIndices[offset]!;
            decisions[index] = this.judge(jevRequests[offset]!, result.answers[offset]!);
          }
        }
      } catch (error) {
        usage.push(...providerUsage(error));
        for (const index of jevIndices) decisions[index] = this.failureDecision(error, signal);
      }
    }
    const fallbackUsage = await Promise.all(prepared.map(async (p, index): Promise<UsageRecord[]> => {
      const req = p.request;
      if (!req) return [];
      if (p.enumeration === 'unsupported' && req.strategy !== 'gpt-only') { decisions[index] = host('unsupported_schema'); return []; }
      if (req.strategy === 'gpt-only' || (req.candidates.length === 0 && p.enumeration === 'explicit')) {
        decisions[index] = host('no_candidates');
      } else if (req.candidates.length === 0 && p.enumeration !== 'explicit') {
        decisions[index] = host('no_candidates');
        return [];
      }
      if (decisions[index]!.status === 'selected') return [];
      if (req.strategy === 'jev-only') return [];
      if (req.strategy !== 'gpt-only' && this.config.routing.fallback !== 'gpt') return [];
      const generated = await this.generate(req, signal, deadline);
      decisions[index] = generated.decision;
      return generated.usage;
    }));
    usage.push(...fallbackUsage.flat());
    return { decisions: signal?.aborted ? decisions.map(() => host('cancelled')) : decisions, usage, latencyMs: elapsed(start) };
  }

  private async routePrepared(request: PreparedRequest, caller?: AbortSignal): Promise<RouteResult> {
    const start = now();
    const deadline = start + this.config.routing.totalTimeoutMs;
    const usage: UsageRecord[] = [];
    let decision: Decision = host('no_candidates');
    if (caller?.aborted) return { decision: host('cancelled'), usage, latencyMs: elapsed(start) };
    if (request.strategy !== 'gpt-only' && request.candidates.length) {
      try {
        const result = await this.callProvider('jev', caller, s => this.jev!.choose([request], s), deadline);
        usage.push(...result.usage);
        decision = result.answers.length === 1 ? this.judge(request, result.answers[0]!) : host('invalid_response');
      } catch (error) { usage.push(...providerUsage(error)); decision = this.failureDecision(error, caller); }
    }
    if (decision.status === 'selected' || request.strategy === 'jev-only' || caller?.aborted)
      return { decision: caller?.aborted ? host('cancelled') : decision, usage, latencyMs: elapsed(start) };
    if (request.strategy === 'gpt-only' || (this.config.routing.fallback === 'gpt' && (request.candidates.length > 0 || request.candidates !== undefined))) {
      const generated = await this.generate(request, caller, deadline);
      usage.push(...generated.usage);
      decision = generated.decision;
    }
    return { decision, usage, latencyMs: elapsed(start) };
  }

  private judge(request: PreparedRequest, answer: ChoiceAnswer): Decision {
    const ids = request.candidates.map(c => c.id);
    const choices = [...ids, ESCALATE];
    if (!answer || typeof answer.choice !== 'string' || !choices.includes(answer.choice)
      || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
      || !answer.probabilities || typeof answer.probabilities !== 'object' || Array.isArray(answer.probabilities)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(answer.probabilities))
      || Object.keys(answer.probabilities).length !== choices.length
      || choices.some(id => !Object.hasOwn(answer.probabilities, id))
      || choices.some(id => !Number.isFinite(answer.probabilities[id]) || answer.probabilities[id]! < 0 || answer.probabilities[id]! > 1)
      || Math.abs(choices.reduce((sum, id) => sum + answer.probabilities[id]!, 0) - 1) > 0.001) return host('invalid_response');
    if (answer.choice === ESCALATE) return host('model_escalated');
    const probability = answer.probabilities[answer.choice]!;
    const margin = probability - Math.max(...choices.filter(id => id !== answer.choice).map(id => answer.probabilities[id]!));
    if (margin <= 0) return host('invalid_response');
    const metrics = { confidence: answer.confidence, probability, margin };
    if (answer.confidence < this.config.routing.minConfidence) return { ...host('low_confidence'), ...metrics };
    if (probability < this.config.routing.minProbability) return { ...host('low_probability'), ...metrics };
    if (margin < this.config.routing.minMargin) return { ...host('low_margin'), ...metrics };
    const candidate = request.candidates.find(c => c.id === answer.choice)!;
    if (!validateCall(candidate, request.tools)) return host('invalid_candidate');
    return { status: 'selected', source: 'jev', call: { tool: candidate.tool, arguments: structuredClone(candidate.arguments) }, candidateId: candidate.id,
      requiresApproval: request.tools.find(t => t.name === candidate.tool)?.readOnly !== true, ...metrics };
  }

  private async generate(request: PreparedRequest, signal?: AbortSignal, deadline?: number): Promise<{ decision: Decision; usage: UsageRecord[] }> {
    try {
      const result = await this.callProvider('gpt', signal, s => this.gpt!.generate(request, s), deadline);
      const usage = result.usage;
      if (!result.call) return { decision: host('model_escalated'), usage };
      if (!validateCall(result.call, request.tools)) return { decision: host('invalid_response'), usage };
      let candidateId: string | undefined;
      if (request.candidates.length) {
        const candidate = request.candidates.find(c => c.id === result.candidateId);
        if (!candidate || candidate.tool !== result.call.tool || JSON.stringify(candidate.arguments) !== JSON.stringify(result.call.arguments))
          return { decision: host('invalid_response'), usage };
        candidateId = candidate.id;
      }
      return { decision: { status: 'selected', source: 'gpt', call: structuredClone(result.call), candidateId,
        requiresApproval: request.tools.find(t => t.name === result.call!.tool)?.readOnly !== true }, usage };
    } catch (error) { return { decision: this.failureDecision(error, signal), usage: providerUsage(error) }; }
  }

  private async callProvider<T>(name: ProviderName, caller: AbortSignal | undefined, call: (signal: AbortSignal) => Promise<T>, deadline?: number): Promise<T> {
    if ((name === 'jev' && !this.jev) || (name === 'gpt' && !this.gpt)) throw new ProviderError('missing_provider');
    const breaker = this.breakers[name];
    if (breaker.until > this.clock()) throw new ProviderError('circuit_open');
    const remaining = Math.min(this.config.routing.totalTimeoutMs, (deadline ?? now() + this.config.routing.totalTimeoutMs) - now());
    if (remaining <= 0) throw new ProviderError('timeout');
    const controller = new AbortController();
    let abortSource: 'caller' | 'timeout' | undefined;
    const onAbort = () => {
      if (abortSource) return;
      abortSource = 'caller';
      controller.abort(caller?.reason ?? abortError());
    };
    caller?.addEventListener('abort', onAbort, { once: true });
    if (caller?.aborted) onAbort();
    const timeout = setTimeout(() => {
      if (abortSource) return;
      abortSource = 'timeout';
      controller.abort(new Error('timeout'));
    }, Math.min(remaining, name === 'jev' ? this.config.jev.timeoutMs : this.config.gpt.timeoutMs));
    let started = false;
    try {
      const value = await this.semaphore.use(() => {
        started = true;
        return waitFor(call(controller.signal), controller.signal);
      }, controller.signal);
      breaker.failures = 0;
      breaker.until = 0;
      return value;
    } catch (error) {
      if (started && abortSource !== 'caller' && !(error instanceof ProviderError && error.code === 'circuit_open')) {
        breaker.failures++;
        if (breaker.failures >= this.config.routing.breakerThreshold) breaker.until = this.clock() + this.config.routing.breakerCooldownMs;
      }
      if (controller.signal.aborted && started && !(error instanceof ProviderError)) {
        const providerConfig = name === 'jev' ? this.config.jev : this.config.gpt;
        throw new ProviderError(caller?.aborted ? 'cancelled' : 'timeout', [{
          provider: name, model: providerConfig.model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
          estimatedCostUsd: 0, estimated: true, costUncertain: true,
        }]);
      }
      throw error;
    } finally { clearTimeout(timeout); caller?.removeEventListener('abort', onAbort); }
  }

  private errorReason(error: unknown, caller?: AbortSignal): ReasonCode {
    if (caller?.aborted) return 'cancelled';
    if (error instanceof ProviderError && error.code === 'circuit_open') return 'circuit_open';
    if (error instanceof ProviderError && error.code === 'timeout') return 'timeout';
    if (error instanceof Error && error.name === 'AbortError') return 'timeout';
    return 'provider_error';
  }

  private failureDecision(error: unknown, caller?: AbortSignal): Decision {
    const reason = this.errorReason(error, caller);
    const code = error instanceof ProviderError ? error.code : '';
    const failureCategory = reason === 'cancelled' ? 'cancelled' : reason === 'timeout' ? 'timeout'
      : code === 'unauthorized' ? 'authentication' : code === 'rate_limited' ? 'rate_limit'
        : code === 'network' ? 'network' : ['malformed_response', 'response_too_large'].includes(code) ? 'malformed_response'
          : code === 'missing_api_key' ? 'configuration' : ['unavailable', 'circuit_open'].includes(code) ? 'unavailable' : 'unknown';
    return { ...host(reason), failureCategory };
  }
}

function providerUsage(error: unknown): UsageRecord[] { return error instanceof ProviderError ? error.usage : []; }

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); setImmediate(() => reject(abortError())); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); if (signal.aborted) reject(abortError()); else resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
