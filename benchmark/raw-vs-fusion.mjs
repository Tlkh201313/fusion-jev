// Raw vs Fusion on real commands: what bytes the host would see from each, wall-clock time,
// exit-code preservation, whether a key diagnostic line survives, and byte-exact receipt recovery
// (or, for small output Fusion prints verbatim with no receipt, byte-exact passthrough).
// This measures tool OUTPUT only. It does not measure host end-to-end token usage, billing or task quality.
//
// Usage (after `npm run build`):
//   node benchmark/raw-vs-fusion.mjs [--runs=3] [--out=benchmark/results/NAME] [--tokenizer=DIR_CONTAINING_gpt-tokenizer]
// Writes NAME.json and NAME.csv. Scratch fixtures are generated in a temp directory and removed afterwards.
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const spawn = require('cross-spawn');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repo, 'dist', 'cli.js');
const option = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runs = Number(option('runs', '3'));
const out = resolve(repo, option('out', `benchmark/results/${new Date().toISOString().slice(0, 10)}-raw-vs-fusion`));

let countTokens = null;
const tokenizerDir = option('tokenizer', null);
if (tokenizerDir) {
  const mod = await import(pathToFileURL(join(tokenizerDir, 'node_modules', 'gpt-tokenizer', 'esm', 'encoding', 'o200k_base.js')).href)
    .catch(() => import(pathToFileURL(createRequire(join(tokenizerDir, 'x.js')).resolve('gpt-tokenizer/encoding/o200k_base')).href));
  countTokens = text => mod.encode(text, { allowedSpecial: 'all' }).length;
}

// ---- scratch fixtures --------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'fusion-raw-vs-fusion-'));
const tscBin = join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', types: [] }, include: ['src/**/*.ts'] });
function project(name, files) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'tsconfig.json'), tsconfig);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  return dir;
}
const okFiles = Object.fromEntries(Array.from({ length: 20 }, (_, i) =>
  [`src/ok${i + 1}.ts`, `export function helper${i + 1}(value: number): number {\n  return value * ${i + 1};\n}\n`]));
const tscSmall = project('tsc-small', { ...okFiles, 'src/bad.ts': [
  "import { helper1 } from './ok1.js';",
  'export interface User { id: number; name: string }',
  "export function greet(user: User): string {\n  return 'hi ' + user.name;\n}",
  'const count: string = helper1(2);',
  "export const u: User = { id: 1, name: 'a', email: 'x' };",
  "greet({ id: '2', name: 'b' });",
  'export { count };', ''].join('\n') });
const tscMany = project('tsc-many', Object.fromEntries(Array.from({ length: 12 }, (_, f) =>
  [`src/mod${f + 1}.ts`, Array.from({ length: 5 }, (_, i) => `export const v${f + 1}_${i + 1}: string = ${i + 1};\n`).join('')])));
const testDir = join(scratch, 'node-test');
mkdirSync(testDir);
writeFileSync(join(testDir, 'math.test.mjs'), [
  "import test from 'node:test';", "import assert from 'node:assert/strict';", 'const sum = (a, b) => a + b;',
  'for (let i = 0; i < 40; i++) test(`sum case ${i}`, () => assert.equal(sum(i, 1), i + 1));',
  "test('sum handles negative offset', () => assert.equal(sum(2, -1), 3));",
  'for (let i = 40; i < 60; i++) test(`sum case ${i}`, () => assert.equal(sum(i, 1), i + 1));', ''].join('\n'));

const node = process.execPath;
// marker: a string that identifies the failure; null for passing/informational commands.
const cases = [
  { id: 'npm-typecheck-pass', argv: ['npm', 'run', 'typecheck'], cwd: repo, marker: null, kind: 'pass' },
  { id: 'tsc-fail-3-errors', argv: [node, tscBin, '-p', '.'], cwd: tscSmall, marker: "Type 'number' is not assignable to type 'string'", kind: 'fail' },
  { id: 'tsc-fail-60-errors', argv: [node, tscBin, '-p', '.'], cwd: tscMany, marker: "Type 'number' is not assignable to type 'string'", kind: 'fail' },
  { id: 'node-test-pass-setup', argv: ['npx', 'tsx', '--import', './test/offline-env.ts', '--test', 'test/setup.test.ts'], cwd: repo, marker: null, kind: 'pass' },
  { id: 'node-test-fail-1-of-61', argv: [node, '--test', 'math.test.mjs'], cwd: testDir, marker: 'sum handles negative offset', kind: 'fail' },
  { id: 'git-log-50', argv: ['git', 'log', '-50'], cwd: repo, marker: null, kind: 'info' },
  { id: 'git-log-p-20', argv: ['git', 'log', '-p', '-n', '20'], cwd: repo, marker: null, kind: 'info' },
  { id: 'git-diff-head3-stat', argv: ['git', 'diff', 'HEAD~3', '--stat'], cwd: repo, marker: null, kind: 'info' },
  { id: 'readme-200-line-noise', argv: [node, '-e', "for (let i=0;i<200;i++) console.log('unchanged context '+i); console.error('src/example.ts:4:2 - error TS2322: fixture failure'); process.exitCode=2"], cwd: repo, marker: 'fixture failure', kind: 'fail' },
  { id: 'tiny-node-version', argv: [node, '--version'], cwd: repo, marker: null, kind: 'info' },
  { id: 'tiny-git-status', argv: ['git', 'status', '--short', '--', 'src'], cwd: repo, marker: null, kind: 'info' },
];

// ---- measurement -------------------------------------------------------------------------------
const sha = buf => createHash('sha256').update(buf).digest('hex');
function exec(argv, cwd) {
  const start = performance.now();
  const child = spawn.sync(argv[0], argv.slice(1), { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, env: process.env });
  const ms = performance.now() - start;
  if (child.error) throw child.error;
  return { stdout: child.stdout, stderr: child.stderr, status: child.status, ms };
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
// Test runners and tsc print timings; normalize those for a secondary "same modulo timings" check.
const normalize = buf => buf.toString('utf8').replace(/\d+(\.\d+)?\s?(ms|s)\b/g, 'N$2').replace(/duration_ms[^\n]*/g, 'duration_ms');

// ---- Fusion output parsing (begin parseFusionRun) ---------------------------------------------
// Two shapes. Small complete output (<= 1 KiB, UTF-8, unredacted) is printed verbatim followed by one
// `exitCode=N durationMs=N` line and writes no receipt. Anything else starts with a
// `termination=...` status line naming `stdout=<id> stdoutStoredBytes=N` / `stderr=<id> ...` only for
// non-empty channels; `*OriginalBytes` appears only when it differs from the stored count, and
// `*Truncated=true` / `*Redacted=true` only when true.
function parseFusionRun(stdoutText) {
  const firstLine = stdoutText.split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith('termination=')) {
    // The status line is always last; everything before it is the child's stdout, plus one '\n'
    // the CLI inserts when that stdout does not already end with a newline.
    const status = stdoutText.match(/(?:^|\n)(exitCode=(\S+) durationMs=(\d+))\r?\n?$/);
    if (!status) return { mode: 'unknown' };
    const shown = stdoutText.slice(0, status.index + (status[0].startsWith('\n') ? 1 : 0));
    return { mode: 'verbatim', exitCode: status[2] === 'null' ? null : Number(status[2]), shownStdout: shown };
  }
  const field = name => firstLine.match(new RegExp(`(?:^| )${name}=([^ ]+)`))?.[1];
  const channel = name => {
    const id = field(name);
    if (!id) return { id: null, storedBytes: 0, originalBytes: 0, truncated: false, redacted: false };
    const storedBytes = Number(field(`${name}StoredBytes`));
    const original = field(`${name}OriginalBytes`);
    return { id, storedBytes, originalBytes: original === undefined ? storedBytes : original === 'null' ? null : Number(original),
      truncated: field(`${name}Truncated`) === 'true', redacted: field(`${name}Redacted`) === 'true' };
  };
  const exit = field('exitCode');
  return { mode: 'compact', termination: field('termination'), exitCode: exit === undefined || exit === 'null' ? null : Number(exit),
    stdout: channel('stdout'), stderr: channel('stderr') };
}
// ---- (end parseFusionRun) ----------------------------------------------------------------------

const rows = [];
try {
  for (const c of cases) {
    const raw = [], fusion = [];
    let restore = null;
    for (let r = 0; r < runs; r++) {
      const order = r % 2 === 0 ? ['raw', 'fusion'] : ['fusion', 'raw'];
      for (const which of order) {
        if (which === 'raw') raw.push(exec(c.argv, c.cwd));
        else fusion.push(exec([node, cli, 'run', `--cwd=${c.cwd}`, '--', ...c.argv], c.cwd));
      }
      if (r === 0) {
        // Recover both channels from the first Fusion run's receipts and compare with the adjacent raw run.
        const parsed = parseFusionRun(fusion[0].stdout.toString('utf8'));
        if (parsed.mode !== 'compact') {
          // Nothing was omitted, so there is no receipt to restore; check the passthrough instead.
          const rawStdout = raw[0].stdout.toString('utf8');
          const expected = rawStdout && !rawStdout.endsWith('\n') ? `${rawStdout}\n` : rawStdout;
          restore = {
            restore: parsed.mode === 'verbatim' ? 'n/a (shown verbatim)' : 'n/a (unrecognized output)',
            stdoutTruncated: false, stdoutRedacted: false, stderrTruncated: false, stderrRedacted: false,
            recoveredBytesMatchFusionOriginal: null, recoveredShaEqualsRawRun: null, recoveredEqualsRawModuloTimings: null,
            verbatimEqualsRawRun: parsed.mode === 'verbatim' && parsed.shownStdout === expected && sha(fusion[0].stderr) === sha(raw[0].stderr),
          };
        } else {
          // An empty channel gets no receipt: its recovered bytes are empty by definition.
          const recover = ch => ch.id ? exec([node, cli, 'evidence', ch.id, '--raw'], repo).stdout : Buffer.alloc(0);
          const rec = { stdout: recover(parsed.stdout), stderr: recover(parsed.stderr) };
          restore = {
            restore: 'receipt',
            stdoutTruncated: parsed.stdout.truncated, stdoutRedacted: parsed.stdout.redacted,
            stderrTruncated: parsed.stderr.truncated, stderrRedacted: parsed.stderr.redacted,
            recoveredBytesMatchFusionOriginal: rec.stdout.length === parsed.stdout.originalBytes && rec.stderr.length === parsed.stderr.originalBytes,
            recoveredShaEqualsRawRun: sha(rec.stdout) === sha(raw[0].stdout) && sha(rec.stderr) === sha(raw[0].stderr),
            recoveredEqualsRawModuloTimings: normalize(rec.stdout) === normalize(raw[0].stdout) && normalize(rec.stderr) === normalize(raw[0].stderr),
            verbatimEqualsRawRun: null,
            recoveredStdoutSha: sha(rec.stdout), rawStdoutSha: sha(raw[0].stdout),
            recoveredStderrSha: sha(rec.stderr), rawStderrSha: sha(raw[0].stderr),
          };
        }
      }
    }
    const rawText = Buffer.concat([raw[0].stdout, raw[0].stderr]).toString('utf8');
    const fusionText = Buffer.concat([fusion[0].stdout, fusion[0].stderr]).toString('utf8');
    const rawBytes = raw[0].stdout.length + raw[0].stderr.length;
    const fusionBytes = fusion[0].stdout.length + fusion[0].stderr.length;
    const row = {
      case: c.id, command: c.argv.map(a => a === node ? 'node' : a === tscBin ? 'tsc' : a).join(' '), kind: c.kind,
      rawBytes, fusionBytes, byteReductionPercent: +(100 * (1 - fusionBytes / rawBytes)).toFixed(1),
      rawTokensBytesDiv4: Math.ceil(rawBytes / 4), fusionTokensBytesDiv4: Math.ceil(fusionBytes / 4),
      rawTokensO200k: countTokens ? countTokens(rawText) : null, fusionTokensO200k: countTokens ? countTokens(fusionText) : null,
      rawMedianMs: +median(raw.map(x => x.ms)).toFixed(0), fusionMedianMs: +median(fusion.map(x => x.ms)).toFixed(0),
      rawMs: raw.map(x => +x.ms.toFixed(0)), fusionMs: fusion.map(x => +x.ms.toFixed(0)),
      rawExit: raw[0].status, fusionExit: fusion[0].status, exitPreserved: raw.every((x, i) => x.status === fusion[i].status),
      markerInRaw: c.marker ? rawText.includes(c.marker) : null, markerInFusion: c.marker ? fusionText.includes(c.marker) : null,
      rawOutputStableAcrossRuns: raw.every(x => sha(x.stdout) === sha(raw[0].stdout) && sha(x.stderr) === sha(raw[0].stderr)),
      ...restore,
      fusionSample: fusionText,
    };
    rows.push(row);
    process.stderr.write(`${c.id}: raw ${rawBytes}B ${row.rawMedianMs}ms | fusion ${fusionBytes}B ${row.fusionMedianMs}ms | exit ${row.rawExit}/${row.fusionExit} | ${row.restore === 'receipt' ? `restoreExact ${row.recoveredShaEqualsRawRun}` : `${row.restore}, verbatimExact ${row.verbatimEqualsRawRun}`}\n`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const environment = { date: new Date().toISOString(), os: `${process.platform} ${require('node:os').release()}`, node: process.version,
  fusionJev: JSON.parse(require('node:fs').readFileSync(join(repo, 'package.json'), 'utf8')).version,
  commit: spawn.sync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim(), runs,
  tokenizer: countTokens ? 'gpt-tokenizer o200k_base (OpenAI encoding; proxy only, not a Claude tokenizer)' : 'none' };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(`${out}.json`, `${JSON.stringify({ kind: 'raw-vs-fusion-real-commands',
  note: 'Bytes/tokens of tool output the host would receive (stdout+stderr). Not host end-to-end token usage, billing or task quality.',
  environment, rows }, null, 2)}\n`);
const cols = ['case', 'command', 'kind', 'rawBytes', 'fusionBytes', 'byteReductionPercent', 'rawTokensBytesDiv4', 'fusionTokensBytesDiv4',
  'rawTokensO200k', 'fusionTokensO200k', 'rawMedianMs', 'fusionMedianMs', 'rawExit', 'fusionExit', 'exitPreserved', 'markerInRaw', 'markerInFusion',
  'rawOutputStableAcrossRuns', 'restore', 'verbatimEqualsRawRun', 'recoveredBytesMatchFusionOriginal', 'recoveredShaEqualsRawRun', 'recoveredEqualsRawModuloTimings',
  'stdoutTruncated', 'stdoutRedacted', 'stderrTruncated', 'stderrRedacted'];
const csv = v => (v === null || v === undefined) ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
writeFileSync(`${out}.csv`, [cols.join(','), ...rows.map(r => cols.map(k => csv(r[k])).join(','))].join('\n') + '\n');
process.stderr.write(`wrote ${out}.json and ${out}.csv\n`);
