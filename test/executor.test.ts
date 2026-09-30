import test from 'node:test';
import assert from 'node:assert/strict';
import { FusionExecutor } from '../src/executor.js';
import { FusionRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { ESCALATE, type Decision, type RouteRequest } from '../src/types.js';

const definition = { name: 'save', description: 'Save a record', readOnly: false,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
const selected: Decision = { status: 'selected', source: 'jev', call: { tool: 'save', arguments: { text: 'hello' } } };

test('trusted registry requires authorization for writes even when request claims readOnly', async () => {
  let calls = 0;
  const executor = new FusionExecutor({ handlers: [{ definition, async handle() { calls++; return 'saved'; } }] });
  const result = await executor.execute({ ...selected, requiresApproval: false });
  assert.equal(result.status, 'denied');
  assert.equal(calls, 0);
});

test('unknown handlers and invalid arguments never execute', async () => {
  let calls = 0;
  const executor = new FusionExecutor({ handlers: [{ definition, async handle() { calls++; return 'saved'; } }],
    authorizeWrite: async () => true });
  assert.equal((await executor.execute({ status: 'selected', source: 'jev', call: { tool: 'missing', arguments: {} } })).status, 'invalid');
  assert.equal((await executor.execute({ status: 'selected', source: 'jev', call: { tool: 'save', arguments: { text: 4 } } })).status, 'invalid');
  assert.equal(calls, 0);
});

test('authorized writes execute exactly once with trusted validated arguments', async () => {
  const seen: string[] = [];
  const executor = new FusionExecutor({ handlers: [{ definition, async handle(args) { seen.push(args.text as string); return { saved: true }; } }],
    authorizeWrite: async () => true });
  const result = await executor.execute(selected);
  assert.equal(result.status, 'executed');
  assert.deepEqual(result.output, { saved: true });
  assert.deepEqual(seen, ['hello']);
});

test('mutating a registered definition cannot turn a write into an unapproved read', async () => {
  const mutableDefinition = structuredClone(definition);
  let calls = 0;
  const executor = new FusionExecutor({ handlers: [{ definition: mutableDefinition, async handle() { calls++; return 'saved'; } }] });
  mutableDefinition.readOnly = true;
  const result = await executor.execute(selected);
  assert.equal(result.status, 'denied');
  assert.equal(calls, 0);
});

test('authorization callback cannot alter validated arguments sent to a handler', async () => {
  const seen: unknown[] = [];
  const executor = new FusionExecutor({ handlers: [{ definition, async handle(args) { seen.push(args.text); return 'saved'; } }],
    authorizeWrite: async call => { call.arguments.text = 4; return true; } });
  const result = await executor.execute(selected);
  assert.equal(result.status, 'executed');
  assert.deepEqual(seen, ['hello']);
});

test('workflow stops after a timed-out action and never replays it', async () => {
  const config = loadConfig();
  const router = new FusionRouter({ config, jev: { async choose() {
    return { answers: [{ choice: 'save', confidence: 1, probabilities: { save: 0.99, [ESCALATE]: 0.01 } }], usage: [] };
  } } });
  let calls = 0;
  const executor = new FusionExecutor({ router, handlers: [{ definition, async handle() { calls++; return await new Promise(() => {}); } }],
    authorizeWrite: async () => true, maxSteps: 3, totalTimeoutMs: 25 });
  const request: RouteRequest = { task: 'Save text', tools: [{ ...definition, readOnly: true }],
    candidates: [{ id: 'save', tool: 'save', arguments: { text: 'hello' } }], cache: false };
  const result = await executor.runWorkflow(() => request);
  assert.equal(result.status, 'timeout');
  assert.equal(calls, 1);
});

test('workflow step limit halts otherwise successful repeats', async () => {
  const config = loadConfig();
  const router = new FusionRouter({ config, jev: { async choose() {
    return { answers: [{ choice: 'save', confidence: 1, probabilities: { save: 0.99, [ESCALATE]: 0.01 } }], usage: [] };
  } } });
  let calls = 0;
  const executor = new FusionExecutor({ router, handlers: [{ definition, async handle() { calls++; return 'ok'; } }],
    authorizeWrite: async () => true, maxSteps: 2, totalTimeoutMs: 1000 });
  const request: RouteRequest = { task: 'Save text', tools: [definition],
    candidates: [{ id: 'save', tool: 'save', arguments: { text: 'hello' } }], cache: false };
  const result = await executor.runWorkflow(() => request);
  assert.equal(result.status, 'step_limit');
  assert.equal(calls, 2);
});
