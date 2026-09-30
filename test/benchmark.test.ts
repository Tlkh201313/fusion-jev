import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runBenchmark } from '../benchmark/core.js';
import type { RouteResult, Strategy } from '../src/types.js';

test('benchmark rotates strategies, reports accuracy and distinguishes abstention', async () => {
  const seen: Array<{ task: string; strategy: Strategy; cache: boolean | undefined }> = [];
  const tools = [{ name: 'issues', description: 'List issues', inputSchema: { type: 'object',
    properties: { state: { enum: ['open', 'closed'] } }, required: ['state'], additionalProperties: false } }];
  const cases = [
    { task: 'one', tools, expected: { tool: 'issues', arguments: { state: 'open' } } },
    { task: 'two', tools, expected: null },
    { task: 'three', tools, expected: { tool: 'issues', arguments: { state: 'closed' } } },
  ];
  const report = await runBenchmark(cases, async (item, strategy): Promise<RouteResult> => {
    seen.push({ task: item.task, strategy, cache: item.cache });
    return { decision: item.task === 'two' ? { status: 'escalate', source: 'host', reason: 'model_escalated' }
      : { status: 'selected', source: 'jev', call: item.task === 'one'
        ? { tool: 'issues', arguments: { state: 'open' } }
        : { tool: 'issues', arguments: { state: 'closed' } } },
      usage: [{ provider: 'jev', model: 'jev', inputTokens: 10, cachedInputTokens: 0, outputTokens: 2,
        estimatedCostUsd: 0.001, estimated: false, costUncertain: false }], latencyMs: 5 };
  });
  assert.deepEqual(seen.slice(0, 3).map(x => x.strategy), ['fusion', 'gpt-only', 'jev-only']);
  assert.deepEqual(seen.slice(3, 6).map(x => x.strategy), ['gpt-only', 'jev-only', 'fusion']);
  assert.ok(seen.every(x => x.cache === false));
  assert.equal(report.fusion.coverage, 2 / 3);
  assert.equal(report.fusion.abstentions, 1);
  assert.equal(report.fusion.selectedCallAccuracy, 1);
  assert.equal(report.fusion.decisionAccuracy, 1);
  assert.equal(report.fusion.taskSuccess, null);
  assert.equal(report.fusion.attempts, 3);
  assert.equal(report.fusion.inputTokens, 30);
  assert.equal(report.fusion.estimatedCostUsd, null);
  const priced = await runBenchmark(cases, async () => ({ decision: { status: 'escalate', source: 'host', reason: 'model_escalated' },
    usage: [{ provider: 'jev', model: 'jev', inputTokens: 10, cachedInputTokens: 0, outputTokens: 2,
      estimatedCostUsd: 0.001, estimated: false, costUncertain: false }], latencyMs: 5 }), { pricesConfigured: true });
  assert.equal(priced.fusion.estimatedCostUsd, 0.003);
});

test('live benchmark opt-in refuses missing keys before provider calls', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'benchmark/run.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, FUSION_LIVE_BENCHMARK: '1', TYPESAFE_API_KEY: '', OPENAI_API_KEY: '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TYPESAFE_API_KEY and OPENAI_API_KEY are required/);
  assert.equal(result.stdout, '');
});
