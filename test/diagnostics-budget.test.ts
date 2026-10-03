import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EvidenceStore } from '../src/evidence.js';
import { DIAGNOSTIC_BUDGET_BYTES, renderChannelSummary, summarizeChannel } from '../src/command-summary.js';

const tsc = readFileSync(new URL('./fixtures/git-summary/tsc-60-errors.txt', import.meta.url));
const capture = (store: EvidenceStore, bytes: Buffer, argv = ['npx', 'tsc']) =>
  store.capture({ source: { kind: 'command', cwd: process.cwd(), argv, channel: 'stderr' }, bytes });

test('tsc with 60 errors shows as many diagnostics as fit a token budget, not a fixed 4', async () => {
  const store = new EvidenceStore();
  const summary = await summarizeChannel(store, capture(store, tsc));
  assert.ok(summary.diagnostics.length > 12, `got ${summary.diagnostics.length}`);
  assert.ok(summary.diagnostics.length < 60);
  assert.equal(summary.diagnosticsOmitted, 60 - summary.diagnostics.length);
  const rendered = renderChannelSummary(summary);
  const diagnosticBytes = summary.diagnostics.reduce((sum, item) => sum + Buffer.byteLength(item.message), 0);
  assert.ok(diagnosticBytes < DIAGNOSTIC_BUDGET_BYTES);
  assert.match(rendered, new RegExp(`\\+${summary.diagnosticsOmitted} more diagnostics, recover with the receipt`));
  assert.match(rendered, new RegExp(`diagnosticsOmitted=${summary.diagnosticsOmitted}`));
  assert.match(rendered, /by file: src\/api\.ts=22 src\/store\.ts=14 src\/util\.ts=12 src\/view\.ts=12\n/);
});

test('the first diagnostic of every distinct TS code is kept and the shown list stays in source order', async () => {
  const store = new EvidenceStore();
  const noisy = Buffer.concat([
    ...Array.from({ length: 80 }, (_, i) => Buffer.from(`src/a.ts(${i + 1},1): error TS2322: Type 'string' is not assignable to type 'number'.\n`)),
    Buffer.from("src/z.ts(1,1): error TS2304: Cannot find name 'last'.\n"),
  ]);
  const summary = await summarizeChannel(store, capture(store, noisy));
  assert.ok(summary.diagnostics.some(item => item.message.startsWith("Cannot find name 'last'")), 'rare code survives the budget');
  const starts = summary.diagnostics.map(item => item.startByte);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(summary.diagnosticsOmitted, 81 - summary.diagnostics.length);
});

test('errors outrank warnings when the budget is tight', async () => {
  const store = new EvidenceStore();
  const text = Array.from({ length: 100 }, (_, i) => `w.rs:${i + 1}:1: warning: unused variable number ${i}\n`).join('') + 'e.rs:1:1: error: the one real error\n';
  const summary = await summarizeChannel(store, capture(store, Buffer.from(text)));
  assert.ok(summary.diagnostics.some(item => item.severity === 'error'));
});

test('short complete output is still verbatim with zero omissions', async () => {
  const store = new EvidenceStore();
  const text = "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n";
  const summary = await summarizeChannel(store, capture(store, Buffer.from(text)));
  assert.equal(summary.smallText, text);
  assert.equal(summary.diagnosticsOmitted, 0);
  assert.equal(summary.omittedBytes, 0);
  assert.equal(renderChannelSummary(summary), text);
});
