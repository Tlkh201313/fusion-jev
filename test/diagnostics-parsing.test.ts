import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagnostics, scanDiagnostics } from '../src/diagnostics.js';

// Captured from Node v24.12.0 `node --test x.test.mjs` (default spec reporter, non-TTY), paths shortened.
const spec = [
  '✔ passes 0 (0.5296ms)',
  '✖ sum handles negative offset (0.6203ms)',
  '✖ throws plain error (0.6846ms)',
  '▶ suite',
  '  ✖ nested fails (3.059ms)',
  '✖ suite (3.3049ms)',
  'ℹ tests 4',
  'ℹ fail 3',
  '',
  '✖ failing tests:',
  '',
  'test at x.test.mjs:4:1',
  '✖ sum handles negative offset (0.6203ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '  ',
  '  0 !== 1',
  '  ',
  '      at TestContext.<anonymous> (file:///C:/tmp/diag/x.test.mjs:5:10)',
  '      at Test.runInAsyncScope (node:async_hooks:214:14)',
  '      at Test.run (node:internal/test_runner/test:1106:25) {',
  '    generatedMessage: true,',
  "    code: 'ERR_ASSERTION',",
  '  }',
  '',
  'test at x.test.mjs:7:1',
  '✖ throws plain error (0.6846ms)',
  '  Error: boom here',
  '      at TestContext.<anonymous> (file:///C:/tmp/diag/x.test.mjs:7:42)',
  '      at Test.run (node:internal/test_runner/test:1106:25)',
  '',
  'test at x.test.mjs:8:36',
  '✖ nested fails (3.059ms)',
  '  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:',
  '  ',
  '    assert.ok(false)',
  '  ',
  '      at Test.start (node:internal/test_runner/test:1003:17)',
  '      at TestContext.<anonymous> (file:///C:/tmp/diag/x.test.mjs:8:70)',
  '      at Test.runInAsyncScope (node:async_hooks:214:14)',
  '',
].join('\n');

test('node:test spec reporter failures yield one diagnostic per failing test with test-file location', () => {
  const found = parseDiagnostics({ text: spec, sourceEvidenceId: 'spec' });
  const file = process.platform === 'win32' ? 'C:\\tmp\\diag\\x.test.mjs' : '/C:/tmp/diag/x.test.mjs';
  assert.deepEqual(
    found.map((item) => [item.severity, item.file, item.line, item.column, item.message]),
    [
      [
        'error',
        file,
        5,
        10,
        'sum handles negative offset: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 0 !== 1',
      ],
      ['error', file, 7, 42, 'throws plain error: Error: boom here'],
      [
        'error',
        file,
        8,
        70,
        'nested fails: AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert.ok(false)',
      ],
    ],
  );
  assert.equal(
    Buffer.from(spec).subarray(found[0]!.startByte, found[0]!.endByte).toString(),
    '✖ sum handles negative offset (0.6203ms)',
  );
  assert.ok(found[0]!.startByte > spec.indexOf('failing tests:'));
});

test('node:test spec failures without the trailing summary still name the failing test', () => {
  const found = parseDiagnostics({
    text: '✔ ok (1ms)\n✖ breaks (2.1ms)\n  ✖ inner (0.3ms)\n',
    sourceEvidenceId: 'spec',
  });
  assert.deepEqual(
    found.map((item) => [item.message, item.file]),
    [
      ['breaks', undefined],
      ['inner', undefined],
    ],
  );
});

test('node:test spec location falls back to the "test at" line when no file frame exists', () => {
  const found = parseDiagnostics({
    text: '✖ failing tests:\n\ntest at a.test.mjs:3:1\n✖ t (1ms)\n  Error: x\n      at run (node:internal/x:1:1)\n',
    sourceEvidenceId: 's',
  });
  assert.deepEqual(
    found.map((item) => [item.message, item.file, item.line, item.column]),
    [['t: Error: x', 'a.test.mjs', 3, 1]],
  );
});

test('node:test TAP reporter failures still use the not ok path', () => {
  const tap =
    'TAP version 13\n# Subtest: sum handles negative offset\nnot ok 4 - sum handles negative offset\n  ---\n  error: |-\n    Expected values to be strictly equal:\n  ...\n';
  assert.deepEqual(
    parseDiagnostics({ text: tap, sourceEvidenceId: 'tap' }).map((item) => item.message),
    ['sum handles negative offset'],
  );
});

const gitLog = [
  'commit 8a22ed4f0c1d2e3b4a5968778695a4b3c2d1e0f9',
  'Author: A <a@example.com>',
  'Date:   Thu Oct 2 10:00:00 2026 +0000',
  '',
  '    Fix file.ts(3,4): error TS2345: old message in commit body',
  '    main.cpp:4:8: error: also historical',
  '',
  'diff --git a/test/x.test.ts b/test/x.test.ts',
  'index 1111111..2222222 100644',
  '--- a/test/x.test.ts',
  '+++ b/test/x.test.ts',
  '@@ -1,5 +1,6 @@',
  "     expectedStdout: '', expectedStderr: 'file.ts(3,4): error TS2345: expected string\\n',",
  "-  const line = 'src/a.ts(2,4): error TS1000: wrong type';",
  "+  const line = 'src/a.ts(2,4): error TS1000: wrong type';",
  '+file.ts(3,4): error TS2322: Bad type',
  '-main.cpp:4:8: error: missing',
  ' Error: broken',
  '     at run (C:\\repo\\app.js:5:7)',
  '',
  ' not ok 1 - historical',
  '\\ No newline at end of file',
  'commit 5dfdd24f0c1d2e3b4a5968778695a4b3c2d1e0f9',
  'Author: A <a@example.com>',
  '',
  '    error[E0308]: mismatched types',
  '',
].join('\n');

test('git log -p history and diff hunks produce no diagnostics', () => {
  assert.deepEqual(parseDiagnostics({ text: gitLog, sourceEvidenceId: 'git' }), []);
  assert.equal(scanDiagnostics({ text: gitLog, sourceEvidenceId: 'git' }, 4).total, 0);
});

test('real diagnostics after diff content are still recognized', () => {
  const text =
    'diff --git a/x b/x\n@@ -1 +1 @@\n+file.ts(1,1): error TS1: old\n' +
    'src/now.ts(2,3): error TS2322: current failure\n';
  assert.deepEqual(
    parseDiagnostics({ text, sourceEvidenceId: 'mix' }).map((item) => [item.file, item.message]),
    [['src/now.ts', 'current failure']],
  );
});
