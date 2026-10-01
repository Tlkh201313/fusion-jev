import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatGain, formatStatusline, programName, readGain, recordGain } from '../src/gain.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cliArgs = (...args: string[]) => ['--import', import.meta.resolve('tsx'), cli, ...args];

test('gain totals count small-output losses and rank programs by savings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-gain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'gain.jsonl');
  assert.equal(formatStatusline(readGain(log)), 'fusion ready');
  recordGain(log, { t: 1, program: 'npm', capturedBytes: 40_000, shownBytes: 800, exitCode: 1 });
  recordGain(log, { t: 2, program: 'echo', capturedBytes: 5, shownBytes: 900, exitCode: 0 });
  const summary = readGain(log);
  assert.deepEqual([summary.runs, summary.capturedBytes, summary.shownBytes], [2, 40_005, 1_700]);
  assert.deepEqual(summary.byProgram.map(item => item.program), ['npm', 'echo']);
  assert.equal(summary.byProgram[1]!.savedBytes, -895);
  assert.match(formatGain(summary), /runs 2 .*saved 95\.8%/);
  assert.equal(formatStatusline(summary), 'fusion ▾ ~9.6k tok saved · 2 runs');
  assert.equal(programName('C:\\tools\\npm.cmd'.split('\\').join('/')), 'npm');
});

test('fusion-jev run records the program name only, never arguments', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fusion-gain-cli-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const env = { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache };
  const run = spawnSync(process.execPath, cliArgs('run', '--', process.execPath, '-e', 'console.log("x".repeat(5000))', 'secret-argument'), { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const log = await readFile(join(cache, 'fusion-jev-mcp', 'gain.jsonl'), 'utf8');
  assert.doesNotMatch(log, /secret-argument|repeat/);
  assert.match(log, /"capturedBytes":5001/);
  const status = spawnSync(process.execPath, cliArgs('statusline'), { encoding: 'utf8', env });
  assert.match(status.stdout, /^fusion ▾ ~\d/);
});
