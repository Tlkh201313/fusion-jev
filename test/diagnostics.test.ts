import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverChecks, parseDiagnostics } from '../src/diagnostics.js';

test('recognized diagnostics retain deterministic byte offsets and source', () => {
  const text = 'é prefix\nfile.ts(3,4): error TS2322: Bad type\napp.py:9: ValueError: bad\nsrc/lib.rs:7:2: error: mismatch\nmain.go:12:5: warning: unused\nmain.cpp:4:8: error: missing\n';
  const found = parseDiagnostics({ text, sourceEvidenceId: 'ev-1' });
  assert.deepEqual(found.map(item => [item.severity, item.file, item.line, item.column]), [
    ['error', 'file.ts', 3, 4], ['error', 'app.py', 9, undefined], ['error', 'src/lib.rs', 7, 2],
    ['warning', 'main.go', 12, 5], ['error', 'main.cpp', 4, 8],
  ]);
  assert.ok(found.every(item => item.evidenceId === 'ev-1'));
  assert.equal(found[0]!.startByte, Buffer.byteLength('é prefix\n'));
  assert.equal(Buffer.from(text).subarray(found[0]!.startByte, found[0]!.endByte).toString(), 'file.ts(3,4): error TS2322: Bad type');
});

test('false-success text and unknown lines create no diagnosis', () => {
  assert.deepEqual(parseDiagnostics({ text: '0 failed\nProcess exited with code 1\nall good\n', sourceEvidenceId: 'ev-2' }), []);
});

test('common test runner failures are recognized without inferring process success', () => {
  const text = 'not ok 1 - adds values\nFAILED tests/test_math.py::test_sum - AssertionError: 2 != 3\n--- FAIL: TestSum (0.01s)\nerror[E0308]: mismatched types\n --> src/main.rs:8:3\n';
  const found = parseDiagnostics({ text, sourceEvidenceId: 'ev-test' });
  assert.deepEqual(found.map(item => [item.severity, item.file, item.message]), [
    ['error', undefined, 'adds values'],
    ['error', 'tests/test_math.py', 'AssertionError: 2 != 3'],
    ['error', undefined, 'TestSum'],
    ['error', 'src/main.rs', 'mismatched types'],
  ]);
});

test('Node stack error carries the relevant source location', () => {
  const found = parseDiagnostics({ text: 'Error: broken\n    at run (C:\\repo\\app.js:5:7)\n', sourceEvidenceId: 'ev-node' });
  assert.deepEqual(found.map(item => [item.severity, item.file, item.line, item.column, item.message]), [
    ['error', 'C:\\repo\\app.js', 5, 7, 'broken'],
  ]);
});

test('TAP TODO and SKIP directives are not errors', () => {
  const found = parseDiagnostics({ text: 'not ok 1 - pending # TODO later\nnot ok 2 - unsupported # SKIP platform\nnot ok 3 - broken\n', sourceEvidenceId: 'tap' });
  assert.deepEqual(found.map(item => item.message), ['broken']);
});

test('check discovery yields argv from exact manifests across five ecosystems', () => {
  const checks = discoverChecks('C:/repo', [
    { path: 'package.json', content: '{"scripts":{"test":"vitest run","lint":"eslint ."}}' },
    { path: 'pyproject.toml', content: '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' },
    { path: 'Cargo.toml', content: '[package]\nname = "demo"\n' },
    { path: 'go.mod', content: 'module example.com/demo\n' },
    { path: 'CMakeLists.txt', content: 'cmake_minimum_required(VERSION 3.20)\nproject(demo)\n' },
    { path: 'nested/package.json', content: '{"scripts":{"test":"ignore"}}' },
  ]);
  assert.deepEqual(checks.map(({ sourcePath, label, argv }) => ({ sourcePath, label, argv })), [
    { sourcePath: 'package.json', label: 'npm test', argv: ['npm', 'run', 'test'] },
    { sourcePath: 'package.json', label: 'npm lint', argv: ['npm', 'run', 'lint'] },
    { sourcePath: 'pyproject.toml', label: 'pytest', argv: ['pytest'] },
    { sourcePath: 'Cargo.toml', label: 'cargo test', argv: ['cargo', 'test'] },
    { sourcePath: 'go.mod', label: 'go test', argv: ['go', 'test', './...'] },
    { sourcePath: 'CMakeLists.txt', label: 'ctest (host selects configured build directory)', argv: ['ctest'] },
    { sourcePath: 'nested/package.json', label: 'npm test', argv: ['npm', 'run', 'test'] },
  ]);
  assert.ok(checks.every(check => check.requiresApproval && /^[a-f0-9]{64}$/.test(check.sourceSha256)));
});
