import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorkflowFacts, runWorkflowBenchmark, workflowRubrics } from '../benchmark/workflows.js';

function answer(rubric: (typeof workflowRubrics)[number]) {
  if (rubric.id === 'navigation-search') return rubric.citations.map((citation, i) => `${citation} ${rubric.facts[i]}`).join('\n');
  if (rubric.id === 'git-changes') return [...rubric.citations,
    'diff --git a/src/routes.ts b/src/routes.ts', ...rubric.facts.slice(0, 2),
    'diff --git a/src/state.ts b/src/state.ts', ...rubric.facts.slice(2)].join('\n');
  return rubric.facts.map((fact, i) => [...rubric.citations.slice(i * 4, i * 4 + 4), fact].join('\n')).join('\n');
}

test('workflow rubrics require exact task facts and attributed citations', () => {
  for (const rubric of workflowRubrics) {
    const complete = answer(rubric);
    assert.equal(assessWorkflowFacts(complete, rubric).qualityMet, true);
    for (const missing of [...rubric.facts, ...rubric.citations]) {
      const assessed = assessWorkflowFacts(complete.replace(missing, ''), rubric);
      assert.equal(assessed.qualityMet, false, `${rubric.id}: ${missing}`);
    }
  }
});

test('all facts present with swapped source attribution still fails the rubric', () => {
  for (const rubric of workflowRubrics) {
    const complete = answer(rubric);
    const swapped = complete.replace(rubric.facts[0]!, 'FACT_PLACEHOLDER')
      .replace(rubric.facts.at(-1)!, rubric.facts[0]!).replace('FACT_PLACEHOLDER', rubric.facts.at(-1)!);
    const assessed = assessWorkflowFacts(swapped, rubric);
    assert.deepEqual(assessed.missingFacts, []);
    assert.equal(assessed.qualityMet, false, rubric.id);
    assert.ok(assessed.missingCitations.length > 0);
  }
});

test('offline workflows compare actual native, RTK and current MCP without release claims', async () => {
  const report = await runWorkflowBenchmark({ rounds: 1 });
  assert.equal(report.mode, 'offline');
  assert.equal(report.providerCalls, 0);
  assert.equal(report.networkCalls, 0);
  assert.equal(report.observations.length, 9);
  assert.equal(report.superiorityClaim, null);
  assert.match(report.method.tokenEstimate, /estimate.*bytes.*four/i);
  assert.match(report.method.research, /prerecorded.*untrusted/i);
  for (const rubric of workflowRubrics) {
    const rows = report.observations.filter(row => row.workflow === rubric.id);
    assert.deepEqual(rows.map(row => row.strategy), ['native', 'rtk', 'fusion']);
    for (const row of rows) {
      assert.ok(row.hostVisibleBytes > 0);
      assert.equal(row.estimatedTokens, Math.ceil(row.hostVisibleBytes / 4));
      assert.equal(row.costUsd, null);
      assert.ok(row.p50Ms >= 0 && row.p95Ms >= row.p50Ms);
      assert.equal(row.qualityMet, row.available && !row.commandFailure && row.missingFacts.length === 0
        && row.missingCitations.length === 0 && row.exactEvidenceRecovery !== false);
      if (row.strategy === 'fusion' || row.strategy === 'native' && row.available) assert.equal(row.qualityMet, true, JSON.stringify(row));
      if (!row.available) assert.equal(row.qualityMet, false, 'missing optional comparator is disclosed');
      // RTK's installed version may omit facts or fail. Preserve measured outcomes.
      if (row.strategy === 'fusion') {
        assert.equal(row.exactEvidenceRecovery, true);
        assert.ok(row.evidenceExpansionBytes > 0);
      } else assert.equal(row.exactEvidenceRecovery, null);
    }
  }
  assert.deepEqual(report.gates, { hostTokenReduction: 'unverified', cost: 'unverified', latency: 'unverified', quality: 'unverified' });
});

test('workflow execution rejects out-of-bounds rounds before creating fixtures', async () => {
  for (const rounds of [0, 11, 1.5]) await assert.rejects(runWorkflowBenchmark({ rounds }), /rounds/i);
});

test('repeated paired rounds isolate research imports while retaining identical facts', async () => {
  const report = await runWorkflowBenchmark({ rounds: 2 });
  assert.equal(report.providerCalls, 0);
  assert.equal(report.untrustedInstructionExecuted, false);
  assert.ok(report.observations.filter(row => row.strategy === 'fusion').every(row => row.qualityMet), JSON.stringify(report.observations));
});
