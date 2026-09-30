import test from 'node:test';
import assert from 'node:assert/strict';
import { JevProvider } from '../src/providers/jev.js';
import { GptProvider } from '../src/providers/gpt.js';
import { ProviderError } from '../src/errors.js';
import { ESCALATE, type PreparedRequest, type ProviderConfig } from '../src/types.js';

const providerConfig: ProviderConfig = {
  apiKey: 'secret', baseUrl: 'https://api.example.test', model: 'test-model', timeoutMs: 1000,
  inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2,
};
const request: PreparedRequest = {
  task: 'Show open issues', context: { project: 'demo' }, strategy: 'fusion',
  tools: [{ name: 'issues', description: 'List issues', readOnly: true,
    inputSchema: { type: 'object', properties: { state: { enum: ['open', 'closed'] } }, required: ['state'], additionalProperties: false } }],
  candidates: [
    { id: 'open', tool: 'issues', arguments: { state: 'open' } },
    { id: 'closed', tool: 'issues', arguments: { state: 'closed' } },
  ],
};
const answer = (choice = 'open') => ({ type: 'choice', choice, confidence: 0.8,
  probabilities: choice === 'closed'
    ? { open: 0.05, closed: 0.9, [ESCALATE]: 0.05 }
    : { open: 0.9, closed: 0.05, [ESCALATE]: 0.05 } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('Jev maps question IDs to ordered answers and records returned model and usage', async () => {
  let wire: any;
  const fetcher: typeof fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, 'Bearer secret');
    return response({ model: 'jev-1.13.0', answers: { q0: answer(), q1: answer('closed') },
      usage: { input_tokens: 120, output_tokens: 10 } });
  };
  const result = await new JevProvider(providerConfig, fetcher).choose([request, { ...request, task: 'Show closed' }], new AbortController().signal);
  assert.equal(wire.model, 'test-model');
  assert.deepEqual(Object.keys(wire.questions), ['q0', 'q1']);
  assert.deepEqual(Object.keys(wire.questions.q0.criteria), ['open', 'closed', ESCALATE]);
  assert.equal(wire.questions.q0.type, 'choice');
  assert.equal(wire.state[0].task, 'Show open issues');
  assert.equal(wire.state[0].tools, undefined, 'small choices keep the verified prompt');
  assert.match(wire.questions.q0.criteria.open, /List issues/);
  assert.equal(wire.questions.q0.instructions.task, 'Show open issues');
  assert.equal(wire.questions.q0.instructions.context, undefined, 'large context is sent once per request');
  assert.match(wire.questions.q1.instructions.question, /state\[1\]/);
  assert.deepEqual(result.answers.map(a => a.choice), ['open', 'closed']);
  assert.deepEqual(result.usage, [{ provider: 'jev', model: 'jev-1.13.0', inputTokens: 120,
    cachedInputTokens: 0, outputTokens: 10, estimatedCostUsd: 0.00014,
    estimated: false, costUncertain: false }]);
});

test('Jev shares long tool descriptions only when that shrinks a larger candidate set', async () => {
  const description = 'Search the current project for a specific issue state with the exact validated arguments.'.repeat(3);
  const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, tool: 'issues', arguments: { state: `state-${i}` } }));
  let wire: any;
  const fetcher: typeof fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return response({ model: 'jev', answers: { q0: { type: 'choice', choice: 's0', confidence: 0.9,
      probabilities: Object.fromEntries([...candidates.map((candidate, i) => [candidate.id, i === 0 ? 0.89 : 0.01]), [ESCALATE, 0]]) } },
      usage: { input_tokens: 20, output_tokens: 2 } });
  };
  const result = await new JevProvider(providerConfig, fetcher).choose([{ ...request,
    tools: [{ ...request.tools[0]!, description }], candidates }], new AbortController().signal);
  assert.equal(result.answers[0]?.choice, 's0');
  assert.equal(wire.state[0].tools.issues, description);
  assert.ok(Object.values(wire.questions.q0.criteria).every(value => !String(value).includes(description)));
});

test('Jev rejects incomplete or unnormalized distributions', async () => {
  const fetcher: typeof fetch = async () => response({ model: 'jev', answers: { q0: {
    ...answer(), probabilities: { open: 0.9, closed: 0.05 },
  } }, usage: { input_tokens: 4, output_tokens: 2 } });
  await assert.rejects(new JevProvider(providerConfig, fetcher).choose([request], new AbortController().signal),
    (error: any) => error instanceof ProviderError && error.code === 'malformed_response' && error.usage.length === 1);
});

test('Jev rejects distributions outside router tolerance', async () => {
  const fetcher: typeof fetch = async () => response({ model: 'jev', answers: { q0: {
    ...answer(), probabilities: { open: 0.9, closed: 0.05, [ESCALATE]: 0.047 },
  } }, usage: { input_tokens: 4, output_tokens: 2 } });
  await assert.rejects(new JevProvider(providerConfig, fetcher).choose([request], new AbortController().signal),
    (error: any) => error instanceof ProviderError && error.code === 'malformed_response');
});

test('Jev enforces the 254 candidate limit before sending', async () => {
  const candidates = Array.from({ length: 255 }, (_, i) => ({ id: `c${i}`, tool: 'issues', arguments: { state: 'open' } }));
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return response({}); };
  await assert.rejects(new JevProvider(providerConfig, fetcher).choose([{ ...request, candidates }], new AbortController().signal),
    (error: any) => error instanceof ProviderError && error.code === 'too_many_candidates');
  assert.equal(called, false);
});

test('provider failures sanitize response bodies and preserve HTTP status', async () => {
  const fetcher: typeof fetch = async () => new Response('sensitive provider body', { status: 429 });
  await assert.rejects(new JevProvider(providerConfig, fetcher).choose([request], new AbortController().signal),
    (error: any) => error instanceof ProviderError && error.status === 429 && !error.message.includes('sensitive'));
});

test('a cancelled provider call does not expose request data', async () => {
  const controller = new AbortController();
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('provider secret in transport error')));
  });
  const pending = new JevProvider(providerConfig, fetcher).choose([request], controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: any) => error instanceof ProviderError
    && error.code === 'cancelled' && !error.message.includes('secret') && error.usage.length === 1);
});

test('provider caps response bodies before JSON parsing', async () => {
  const fetcher: typeof fetch = async () => new Response('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(new JevProvider(providerConfig, fetcher).choose([request], new AbortController().signal),
    (error: any) => error instanceof ProviderError && error.code === 'response_too_large');
});

test('GPT candidate mode sends strict enum output and accepts only a listed ID', async () => {
  let wire: any;
  const fetcher: typeof fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return response({ status: 'completed', model: 'gpt-test', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '{"candidateId":"closed"}' }] }],
      usage: { input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 10 } } });
  };
  const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
    .generate(request, new AbortController().signal);
  assert.equal(wire.text.format.type, 'json_schema');
  assert.equal(wire.text.format.strict, true);
  assert.deepEqual(wire.text.format.schema.properties.candidateId.enum, ['open', 'closed', ESCALATE]);
  assert.equal(wire.store, false);
  assert.deepEqual(result.call, { tool: 'issues', arguments: { state: 'closed' } });
  assert.equal(result.candidateId, 'closed');
  assert.deepEqual(result.usage, [{ provider: 'gpt', model: 'gpt-test', inputTokens: 30,
    cachedInputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.000033,
    estimated: false, costUncertain: false }]);
});

test('GPT refuses unknown candidate IDs, refusals and incomplete output', async () => {
  for (const body of [
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"candidateId":"invented"}' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'incomplete', output: [] },
  ]) {
    const fetcher: typeof fetch = async () => response(body);
    const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
      .generate(request, new AbortController().signal);
    assert.equal(result.call, null);
  }
});

test('GPT open generation accepts exactly one validated function call', async () => {
  let wire: any;
  const fetcher: typeof fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return response({ status: 'completed', model: 'gpt-test', output: [
      { type: 'function_call', name: 'issues', arguments: '{"state":"open"}' },
    ], usage: { input_tokens: 20, output_tokens: 5 } });
  };
  const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
    .generate({ ...request, candidates: [] }, new AbortController().signal);
  assert.equal(wire.parallel_tool_calls, false);
  assert.equal(wire.tool_choice, 'required');
  assert.equal(wire.tools[0].strict, true);
  assert.equal(wire.tools[1].name, ESCALATE);
  assert.equal(wire.tools[1].strict, true);
  assert.deepEqual(result.call, { tool: 'issues', arguments: { state: 'open' } });
});

test('GPT open generation accepts explicit escalation only through reserved tool', async () => {
  let wire: any;
  const fetcher: typeof fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return response({ status: 'completed', output: [
      { type: 'function_call', name: ESCALATE, arguments: '{}' },
    ], usage: { input_tokens: 20, output_tokens: 5 } });
  };
  const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
    .generate({ ...request, candidates: [] }, new AbortController().signal);
  assert.equal(result.call, null);
  assert.equal(result.usage.length, 1);
  assert.equal(wire.tools[1].name, ESCALATE);
});

test('GPT open generation rejects registered tool collision with escalation', async () => {
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return response({}); };
  const collision: PreparedRequest = { ...request, candidates: [], tools: [{ name: ESCALATE, description: 'Collision',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }] };
  const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
    .generate(collision, new AbortController().signal);
  assert.equal(result.call, null);
  assert.equal(called, false);
});

test('GPT open generation escalates multiple or invalid calls', async () => {
  for (const output of [
    [{ type: 'function_call', name: 'issues', arguments: '{"state":"all"}' }],
    [{ type: 'function_call', name: 'issues', arguments: '{"state":"open"}' },
      { type: 'function_call', name: 'issues', arguments: '{"state":"closed"}' }],
  ]) {
    const fetcher: typeof fetch = async () => response({ status: 'completed', output });
    const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
      .generate({ ...request, candidates: [] }, new AbortController().signal);
    assert.equal(result.call, null);
  }
});

test('GPT open generation does not send a strict schema that changes optional arguments', async () => {
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return response({}); };
  const optional = { ...request, candidates: [], tools: [{ name: 'issues', description: 'List issues',
    inputSchema: { type: 'object', properties: { state: { type: 'string' } }, required: [], additionalProperties: false } }] };
  const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
    .generate(optional, new AbortController().signal);
  assert.equal(result.call, null);
  assert.equal(called, false);
});

test('GPT strict conversion preserves a scalar const as a singleton enum', async () => {
  let wire: any;
  const fetcher: typeof fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return response({ status: 'completed', output: [{ type: 'function_call', name: 'issues', arguments: '{"state":"open"}' }] });
  };
  const constRequest: PreparedRequest = { ...request, candidates: [], tools: [{ name: 'issues', description: 'List issues',
    inputSchema: { type: 'object', properties: { state: { const: 'open' } }, required: ['state'], additionalProperties: false } }] };
  const result = await new GptProvider({ ...providerConfig, maxOutputTokens: 128, reasoningEffort: 'low' }, fetcher)
    .generate(constRequest, new AbortController().signal);
  assert.deepEqual(wire.tools[0].parameters.properties.state, { type: 'string', enum: ['open'] });
  assert.deepEqual(result.call, { tool: 'issues', arguments: { state: 'open' } });
});
