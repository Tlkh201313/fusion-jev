import test from 'node:test';
import assert from 'node:assert/strict';
import { FusionRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { ProviderError } from '../src/errors.js';
import { deferred } from './deferred.js';
import { ESCALATE, type ChoiceAnswer, type ChoiceProvider, type GenerativeProvider, type RouteRequest } from '../src/types.js';

const request: RouteRequest = {
  task: 'Show the open issues',
  tools: [{ name: 'issues', description: 'List issues', readOnly: true,
    inputSchema: { type: 'object', properties: { state: { enum: ['open', 'closed'] } }, required: ['state'], additionalProperties: false } }],
  candidates: [
    { id: 'open', tool: 'issues', arguments: { state: 'open' } },
    { id: 'closed', tool: 'issues', arguments: { state: 'closed' } },
  ],
};
function answer(choice = 'open', confidence = 0.99): ChoiceAnswer {
  return { choice, confidence, probabilities: { open: 0.98, closed: 0.01, [ESCALATE]: 0.01 } };
}
function fixture(a = answer(), fallback: 'host' | 'gpt' = 'gpt') {
  let jevCalls = 0, gptCalls = 0;
  const jev: ChoiceProvider = { async choose(rs) { jevCalls++; return { answers: rs.map(() => a), usage: [] }; } };
  const gpt: GenerativeProvider = { async generate() { gptCalls++; return { call: { tool: 'issues', arguments: { state: 'open' } }, candidateId: 'open', usage: [] }; } };
  const config = loadConfig({ FUSION_FALLBACK: fallback });
  return { router: new FusionRouter({ config, jev, gpt }), jev, gpt, config, counts: () => ({ jevCalls, gptCalls }) };
}

test('a confident validated Jev call skips GPT and caches only the decision', async () => {
  const f = fixture();
  const first = await f.router.route(request);
  assert.equal(first.decision.status, 'selected');
  assert.deepEqual(first.decision.call, request.candidates![0] && { tool: 'issues', arguments: { state: 'open' } });
  assert.equal(first.decision.source, 'jev');
  const second = await f.router.route(request);
  assert.equal(second.decision.reuse, 'cache');
  assert.deepEqual(second.usage, []);
  assert.deepEqual(f.counts(), { jevCalls: 1, gptCalls: 0 });
});

test('provider failure categories remain sanitized in single and batch routes', async () => {
  for (const [code, category] of [
    ['unauthorized', 'authentication'], ['rate_limited', 'rate_limit'], ['network', 'network'],
    ['timeout', 'timeout'], ['malformed_response', 'malformed_response'], ['secret-provider-body', 'unknown'],
  ] as const) {
    const f = fixture(answer(), 'host');
    f.jev.choose = async () => { throw new ProviderError(code); };
    const single = await f.router.route({ ...request, cache: false });
    const batch = await f.router.routeBatch([request]);
    for (const decision of [single.decision, batch.decisions[0]!]) {
      assert.equal(decision.status, 'escalate');
      assert.equal(decision.failureCategory, category);
      assert.equal(JSON.stringify(decision).includes('secret-provider-body'), false);
    }
  }
});

test('uncertainty escalates to GPT rather than trusting the top label', async () => {
  const f = fixture(answer('open', 0.2));
  assert.equal((await f.router.route(request)).decision.source, 'gpt');
  assert.deepEqual(f.counts(), { jevCalls: 1, gptCalls: 1 });
});

test('unknown options and invalid distributions cannot become executable calls', async () => {
  const f = fixture({ choice: 'delete_all', confidence: 1, probabilities: { delete_all: 1 } }, 'host');
  const r = await f.router.route(request);
  assert.equal(r.decision.status, 'escalate');
  assert.equal(r.decision.call, undefined);
});

test('bad arguments fail before either model is called', async () => {
  const f = fixture();
  const r = await f.router.route({ ...request, candidates: [{ id: 'bad', tool: 'issues', arguments: { state: 'all' } }] });
  assert.equal(r.decision.status, 'invalid');
  assert.deepEqual(f.counts(), { jevCalls: 0, gptCalls: 0 });
});

test('Jev outage falls back once; a failed or wrong GPT call is never selected', async () => {
  const f = fixture();
  f.jev.choose = async () => { throw new ProviderError('timeout'); };
  f.gpt.generate = async () => ({ call: { tool: 'issues', arguments: { state: 'invented' } }, usage: [] });
  const r = await f.router.route(request);
  assert.equal(r.decision.status, 'escalate');
  assert.equal(r.decision.call, undefined);
});

test('identical concurrent reads coalesce without reusing billable usage', async () => {
  const f = fixture();
  const results = await Promise.all([f.router.route(request), f.router.route(request)]);
  assert.equal(f.counts().jevCalls, 1);
  assert.equal(results[1]!.decision.reuse, 'inflight');
});

test('batch makes one Jev request for independent decisions', async () => {
  const f = fixture();
  const r = await f.router.routeBatch([{ ...request, cache: false }, { ...request, task: 'List issues that are still open', cache: false }]);
  assert.equal(r.decisions.length, 2);
  assert.ok(r.decisions.every(d => d.status === 'selected'));
  assert.deepEqual(f.counts(), { jevCalls: 1, gptCalls: 0 });
});

test('independent paid-library fallbacks run concurrently within the limit and preserve result and usage order', { timeout: 3000 }, async () => {
  const config = loadConfig({ FUSION_FALLBACK: 'gpt' });
  config.routing.maxConcurrency = 2;
  const gates = Array.from({ length: 4 }, deferred);
  const started = Array.from({ length: 4 }, deferred);
  let active = 0, peak = 0;
  const router = new FusionRouter({ config,
    jev: { async choose(rs) { return { answers: rs.map(() => answer('open', 0.1)), usage: [] }; } },
    gpt: { async generate(req) {
      const index = Number(req.task);
      active++; peak = Math.max(peak, active); started[index]!.resolve();
      await gates[index]!.promise; active--;
      const choice = index % 2 ? 'closed' : 'open';
      return { call: { tool: 'issues', arguments: { state: choice } }, candidateId: choice,
        usage: [{ provider: 'gpt', model: `test-${index}`, inputTokens: index + 1, cachedInputTokens: 0,
          outputTokens: 1, estimatedCostUsd: 0, estimated: false, costUncertain: true }] };
    } },
  });
  const work = router.routeBatch(gates.map((_, index) => ({ ...request, task: String(index), cache: false })));
  await Promise.all([started[0]!.promise, started[1]!.promise]);
  assert.equal(active, 2);
  gates[1]!.resolve(); await started[2]!.promise;
  gates[2]!.resolve(); await started[3]!.promise;
  gates[3]!.resolve(); gates[0]!.resolve();
  const result = await work;
  assert.equal(peak, 2);
  assert.deepEqual(result.decisions.map(item => item.status === 'selected' ? item.call.arguments.state : item.status), ['open', 'closed', 'open', 'closed']);
  assert.deepEqual(result.usage.map(item => item.model), ['test-0', 'test-1', 'test-2', 'test-3']);
});

test('gpt-only and jev-only do not silently become Fusion', async () => {
  const f = fixture(answer('open', 0.2));
  assert.equal((await f.router.route({ ...request, strategy: 'jev-only' })).decision.status, 'escalate');
  assert.deepEqual(f.counts(), { jevCalls: 1, gptCalls: 0 });
  assert.equal((await f.router.route({ ...request, strategy: 'gpt-only' })).decision.source, 'gpt');
});

test('finite optional boolean arguments include omission without inventing values', async () => {
  const config = loadConfig();
  let seen: string[] = [];
  const jev: ChoiceProvider = { async choose(rs) {
    seen = rs[0]!.candidates.map(c => JSON.stringify(c.arguments));
    return { answers: [{ choice: 'c1', confidence: 1,
      probabilities: { c1: 0.97, c2: 0.01, c3: 0.01, [ESCALATE]: 0.01 } }], usage: [] };
  } };
  const router = new FusionRouter({ config, jev });
  const result = await router.route({ task: 'List items', tools: [{ name: 'items', description: 'List', readOnly: true,
    inputSchema: { type: 'object', properties: { archived: { type: 'boolean' } }, additionalProperties: false } }] });
  assert.equal(result.decision.status, 'selected');
  assert.deepEqual(seen, ['{}', '{"archived":false}', '{"archived":true}']);
});

test('finite enum candidates are filtered by additional schema constraints', async () => {
  let seen: Array<{ id: string; arguments: Record<string, unknown> }> = [];
  const jev: ChoiceProvider = { async choose(requests) {
    seen = requests[0]!.candidates;
    const id = seen[0]!.id;
    return { answers: [{ choice: id, confidence: 1, probabilities: { [id]: 0.99, [ESCALATE]: 0.01 } }], usage: [] };
  } };
  const router = new FusionRouter({ config: loadConfig({}), jev });
  const result = await router.route({ task: 'Set level to at least 2', tools: [{ name: 'set_level', description: 'Set level', readOnly: true,
    inputSchema: { type: 'object', properties: { level: { type: 'integer', enum: [1, 2], minimum: 2 } }, required: ['level'], additionalProperties: false } }] });
  assert.deepEqual(seen.map(candidate => candidate.arguments), [{ level: 2 }]);
  assert.equal(result.decision.status, 'selected');
  assert.deepEqual(result.decision.call, { tool: 'set_level', arguments: { level: 2 } });
});

test('open schemas and candidate overflow escalate without partial inference', async () => {
  const f = fixture();
  const open = await f.router.route({ task: 'Search', tools: [{ name: 'search', description: 'Search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] });
  assert.equal(open.decision.status, 'escalate');
  assert.equal(open.decision.reason, 'unsupported_schema');
  const many = await f.router.route({ ...request, candidates: Array.from({ length: 255 }, (_, i) =>
    ({ id: `id${i}`, tool: 'issues', arguments: { state: 'open' } })) });
  assert.equal(many.decision.status, 'invalid');
  assert.equal(many.decision.reason, 'candidate_limit');
  assert.deepEqual(f.counts(), { jevCalls: 0, gptCalls: 0 });
});

test('Jev cannot select a label that its own probabilities rank below another', async () => {
  const f = fixture({ choice: 'open', confidence: 1, probabilities: { open: 0.2, closed: 0.79, [ESCALATE]: 0.01 } }, 'host');
  const result = await f.router.route(request);
  assert.equal(result.decision.status, 'escalate');
  assert.equal(result.decision.reason, 'invalid_response');
});

test('a single deadline bounds Jev plus GPT fallback', async () => {
  const config = loadConfig({ FUSION_FALLBACK: 'gpt', FUSION_TOTAL_TIMEOUT_MS: '35' });
  const jev: ChoiceProvider = { async choose() {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { answers: [answer('open', 0.1)], usage: [] };
  } };
  let aborted = false;
  let startedGpt = false;
  const gpt: GenerativeProvider = { async generate(_request, signal) {
    startedGpt = true;
    await new Promise<void>(resolve => { if (signal.aborted) { aborted = true; resolve(); }
      else signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
    return { call: null, usage: [] };
  } };
  const router = new FusionRouter({ config, jev, gpt });
  const started = Date.now();
  const result = await router.route({ ...request, cache: false });
  assert.equal(result.decision.status, 'escalate');
  assert.equal(result.decision.reason, 'timeout');
  if (startedGpt) assert.equal(aborted, true);
  assert.ok(Date.now() - started < 90);
});

test('cache uses the full request, expires, and never charges a follower twice', async () => {
  const config = loadConfig({ FUSION_CACHE_TTL_MS: '15' });
  let clock = 1_000;
  let calls = 0;
  const record = { provider: 'jev' as const, model: 'jev-test', inputTokens: 10, cachedInputTokens: 0,
    outputTokens: 2, estimatedCostUsd: 0, estimated: false, costUncertain: false };
  const jev: ChoiceProvider = { async choose() { calls++; return { answers: [answer()], usage: [record] }; } };
  const router = new FusionRouter({ config, jev, clock: () => clock });
  assert.equal((await router.route(request)).usage.length, 1);
  assert.deepEqual((await router.route(request)).usage, []);
  assert.equal((await router.route({ ...request, context: { page: 2 } })).usage.length, 1);
  clock += 16;
  assert.equal((await router.route(request)).usage.length, 1);
  assert.equal(calls, 3);
});

test('caller cancellation prevents a selected call and keeps failed usage once', async () => {
  const controller = new AbortController();
  const usage = [{ provider: 'jev' as const, model: 'jev-test', inputTokens: 4, cachedInputTokens: 0,
    outputTokens: 0, estimatedCostUsd: 0, estimated: true, costUncertain: true }];
  const jev: ChoiceProvider = { async choose(_rs, signal) {
    return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ProviderError('aborted', usage)), { once: true }));
  } };
  const router = new FusionRouter({ config: loadConfig({ FUSION_FALLBACK: 'gpt' }), jev,
    gpt: { async generate() { throw new Error('GPT should not run'); } } });
  const pending = router.route(request, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.decision.status, 'escalate');
  assert.equal(result.decision.reason, 'cancelled');
  assert.deepEqual(result.usage, usage);
});

test('noncooperative provider cancellation records an uncertain attempt once', async () => {
  const controller = new AbortController();
  let started = false;
  const jev: ChoiceProvider = { async choose() {
    started = true;
    return await new Promise(() => {});
  } };
  const router = new FusionRouter({ config: loadConfig(), jev });
  const pending = router.route({ ...request, cache: false }, controller.signal);
  assert.equal(started, true);
  controller.abort();
  const result = await pending;
  assert.equal(result.decision.reason, 'cancelled');
  assert.equal(result.usage.length, 1);
  assert.equal(result.usage[0]!.provider, 'jev');
  assert.equal(result.usage[0]!.costUncertain, true);
});

test('breaker suppresses repeated Jev outages and recovers after cooldown', async () => {
  const config = loadConfig({ FUSION_BREAKER_THRESHOLD: '1', FUSION_BREAKER_COOLDOWN_MS: '15' });
  let clock = 1_000;
  let attempts = 0;
  const jev: ChoiceProvider = { async choose() {
    attempts++;
    if (attempts === 1) throw new ProviderError('unavailable');
    return { answers: [answer()], usage: [] };
  } };
  const router = new FusionRouter({ config, jev, clock: () => clock });
  assert.equal((await router.route({ ...request, cache: false })).decision.reason, 'provider_error');
  assert.equal((await router.route({ ...request, cache: false })).decision.reason, 'circuit_open');
  assert.equal(attempts, 1);
  clock += 16;
  assert.equal((await router.route({ ...request, cache: false })).decision.status, 'selected');
  assert.equal(attempts, 2);
});

test('batch preserves input order across Jev judgments and GPT fallback', async () => {
  const config = loadConfig({ FUSION_FALLBACK: 'gpt' });
  const jev: ChoiceProvider = { async choose() { return { answers: [answer(), answer('closed', 0.1)], usage: [] }; } };
  const gpt: GenerativeProvider = { async generate() { return { call: { tool: 'issues', arguments: { state: 'closed' } },
    candidateId: 'closed', usage: [] }; } };
  const router = new FusionRouter({ config, jev, gpt });
  const result = await router.routeBatch([{ ...request, cache: false }, { ...request, task: 'Closed issues', cache: false }]);
  assert.deepEqual(result.decisions.map(d => d.source), ['jev', 'gpt']);
  assert.deepEqual(result.decisions.map(d => d.status === 'selected' ? d.call.arguments.state : null), ['open', 'closed']);
});

test('an aborted caller cannot receive a cached selected call', async () => {
  const f = fixture();
  assert.equal((await f.router.route(request)).decision.status, 'selected');
  const controller = new AbortController();
  controller.abort();
  const result = await f.router.route(request, controller.signal);
  assert.equal(result.decision.status, 'escalate');
  assert.equal(result.decision.reason, 'cancelled');
});

test('cancelling one caller cannot cancel another identical read', async () => {
  const firstController = new AbortController();
  let attempts = 0;
  const jev: ChoiceProvider = { async choose(_requests, signal) {
    attempts++;
    if (attempts === 1) return await new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new ProviderError('aborted')), { once: true }));
    return { answers: [answer()], usage: [] };
  } };
  const router = new FusionRouter({ config: loadConfig(), jev });
  const first = router.route(request, firstController.signal);
  const second = router.route(request);
  firstController.abort();
  assert.equal((await first).decision.reason, 'cancelled');
  assert.equal((await second).decision.status, 'selected');
  assert.equal(attempts, 2);
});

test('batch does not return a selected call when cancelled during provider response', async () => {
  const controller = new AbortController();
  const jev: ChoiceProvider = { async choose() {
    controller.abort();
    return { answers: [answer()], usage: [] };
  } };
  const router = new FusionRouter({ config: loadConfig(), jev });
  const result = await router.routeBatch([request], controller.signal);
  assert.equal(result.decisions[0]!.status, 'escalate');
  assert.equal(result.decisions[0]!.reason, 'cancelled');
});

test('non-JSON context and argument objects fail before inference', async () => {
  const f = fixture();
  const invalidContext = await f.router.route({ ...request, context: { score: Number.POSITIVE_INFINITY } });
  assert.equal(invalidContext.decision.status, 'invalid');
  const invalidArguments = await f.router.route({ task: 'No-op', tools: [{ name: 'noop', description: 'No-op',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    candidates: [{ id: 'date', tool: 'noop', arguments: new Date() as unknown as Record<string, never> }] });
  assert.equal(invalidArguments.decision.status, 'invalid');
  assert.deepEqual(f.counts(), { jevCalls: 0, gptCalls: 0 });
});

test('probability tables must own exactly the offered choice keys', async () => {
  const probabilities = Object.assign(Object.create({ open: 0.98 }) as Record<string, number>,
    { closed: 0.01, [ESCALATE]: 0.01, extra: 0 });
  const f = fixture({ choice: 'open', confidence: 1, probabilities }, 'host');
  const result = await f.router.route(request);
  assert.equal(result.decision.reason, 'invalid_response');
});

test('router snapshots a validated configuration at construction', async () => {
  const invalidConfig = loadConfig();
  invalidConfig.routing.minProbability = Number.NaN;
  assert.throws(() => new FusionRouter({ config: invalidConfig }), /Invalid routing configuration/);
  const f = fixture(answer('open', 0.2), 'host');
  f.config.routing.fallback = 'gpt';
  const result = await f.router.route(request);
  assert.equal(result.decision.source, 'host');
  assert.deepEqual(f.counts(), { jevCalls: 1, gptCalls: 0 });
});
