import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRecovery, runSupportBenchmark } from '../benchmark/support.js';
import { supportFixtures } from '../benchmark/support-fixtures.js';

test('recovery compares full bytes including newline and stdout/stderr channels', () => {
  const expected = { stdout: Buffer.from('café 🔬\n'), stderr: Buffer.alloc(0) };
  assert.equal(assessRecovery(expected, expected).exactRecovery, true);
  for (const actual of [
    { stdout: Buffer.from('café 🔬'), stderr: Buffer.alloc(0) },
    { stdout: Buffer.from('café '), stderr: Buffer.alloc(0) },
    { stdout: Buffer.alloc(0), stderr: Buffer.from('café 🔬\n') },
    { stdout: Buffer.from('café 🔬\nextra'), stderr: Buffer.alloc(0) },
  ]) {
    const recovery = assessRecovery(actual, expected);
    assert.equal(recovery.exactRecovery, false);
    assert.equal(recovery.silentLoss, true);
  }
  assert.deepEqual(
    supportFixtures.map((fixture) => [fixture.expectedStdout, fixture.expectedStderr]),
    [
      ['export const marker = "café 漢字 🔬";\n', ''],
      ['', 'file.ts(3,4): error TS2345: expected string, received number\n'],
    ],
  );
});

test('offline paired support benchmark reports measured local observations without acceptance claims', async () => {
  const report = await runSupportBenchmark({ rounds: 1 });
  assert.equal(report.mode, 'offline');
  assert.equal(report.method.tokenEstimate, 'utf8-serialized-bytes-divided-by-four');
  assert.deepEqual(report.strategies, ['native', 'rtk', 'fusion']);
  assert.equal(report.observations.length, report.fixtures.length * 3);
  for (const fixture of report.fixtures) {
    assert.deepEqual(
      report.observations
        .filter((item) => item.fixtureId === fixture.id)
        .map((item) => item.strategy)
        .sort(),
      ['fusion', 'native', 'rtk'],
    );
  }
  for (const item of report.observations) {
    assert.ok(item.hostVisibleBytes >= 0);
    assert.equal(item.tokenEstimate, Math.ceil(item.hostVisibleBytes / 4));
    assert.equal(item.costUsd, null);
    assert.equal(item.unauthorizedExecution, false);
    if (item.strategy !== 'rtk') {
      assert.equal(item.wrongPassFail, false);
      assert.equal(item.diagnosticTruthMatched, true);
      assert.equal(item.silentLoss, false);
      assert.equal(item.exactRecovery, true);
      assert.equal(item.qualityMet, true);
    } else {
      // Installed RTK versions/settings may add notices or change formatting. Report
      // the actual measured recovery rather than prescribing the competitor's result.
      assert.equal(
        item.qualityMet,
        item.available && item.exactRecovery && item.diagnosticTruthMatched && !item.wrongPassFail,
      );
      assert.equal(item.silentLoss, item.available && !item.exactRecovery);
    }
  }
  assert.equal(report.gates.hostTokenReduction, 'unverified');
  assert.equal(report.gates.cost, 'unverified');
  assert.equal(report.gates.latency, 'unverified');
  assert.equal(report.gates.quality, 'unverified');
  assert.equal(report.superiorityClaim, null);
  assert.equal(report.windowsPrivateCacheStartupMs === null || report.windowsPrivateCacheStartupMs >= 0, true);
});

test('missing RTK comparator remains explicitly unavailable without discarding native/Fusion measurements', async () => {
  const report = await runSupportBenchmark({ rounds: 1, rtkExecutable: 'fusion-nonexistent-rtk-fixture' });
  for (const item of report.observations.filter((item) => item.strategy === 'rtk')) {
    assert.equal(item.available, false);
    assert.equal(item.qualityMet, false);
    assert.equal(item.silentLoss, false, 'unavailable capture is disclosed, not silent loss');
    assert.equal(item.wrongPassFail, false, 'no child ran');
  }
  assert.ok(report.observations.filter((item) => item.strategy !== 'rtk').every((item) => item.qualityMet));
});

test('noisy command benchmarks measure compact presentation separately from recovery', async () => {
  const report = await runSupportBenchmark({ rounds: 1, corpus: 'noisy' } as any);
  assert.ok(report.fixtures.length >= 6);
  const fusion = report.observations.filter((item) => item.strategy === 'fusion');
  assert.ok(fusion.every((item) => item.exactRecovery && !item.silentLoss));
  assert.ok(
    fusion.some((item) => {
      const native = report.observations.find(
        (other) => other.fixtureId === item.fixtureId && other.strategy === 'native',
      )!;
      return item.hostVisibleBytes < native.hostVisibleBytes / 2;
    }),
  );
  assert.match(report.method.bytes, /compact.*expansion/i);
});
