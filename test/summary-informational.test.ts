import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EvidenceStore } from '../src/evidence.js';
import { renderChannelSummary, summarizeChannel } from '../src/command-summary.js';
import { summarizeGit } from '../src/git-summary.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/git-summary/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bytes = (text: string) => Buffer.byteLength(text);

test('git log default format lists subjects with author and date, never message bodies', () => {
  const raw = fixture('log-50.txt');
  const out = summarizeGit(['git', 'log', '-50'], raw)!;
  assert.ok(out, 'recognized');
  assert.match(out, /^git log: \d+ commits \(subjects only; message bodies omitted\)\n/);
  assert.match(out, /^[0-9a-f]{7} .+ \(.+, \d{4}-\d{2}-\d{2}\)$/m);
  assert.doesNotMatch(out, /^ {4}|^Author:|^commit /m);
  assert.ok(bytes(out) * 3 < bytes(raw), `expected at least 3x smaller, got ${bytes(raw)} -> ${bytes(out)}`);
  assert.equal(out.split('\n').filter(line => /^[0-9a-f]{7} /.test(line)).length, raw.match(/^commit [0-9a-f]{40}/gm)!.length);
});

test('git log -p reports per-commit files and +/- totals without diff bodies', () => {
  const raw = fixture('log-p-5.txt');
  const out = summarizeGit(['git', 'log', '-p', '-n', '3', '--', 'src/diagnostics.ts', 'src/run.ts'], raw)!;
  assert.match(out, /^git log: 2 commits \| 4 files changed \(\+490 -36\) \(subjects only; message bodies and diffs omitted\)\n/);
  assert.match(out, /\[2 files \+85 -36\]/);
  assert.match(out, /\[2 files \+405 -0\]/);
  assert.doesNotMatch(out, /^[-+@]|diff --git/m);
  assert.ok(bytes(out) * 20 < bytes(raw));
});

test('git log --stat and --oneline parse', () => {
  const stat = summarizeGit(['git', 'log', '--stat', '-n', '8'], fixture('log-stat-8.txt'))!;
  assert.match(stat, /\[29 files \+1905 -132\]/);
  assert.match(stat, /^git log: 8 commits \| 55 files changed \(\+2269 -187\)/);
  const oneline = summarizeGit(['git', 'log', '--oneline', '-50'], fixture('log-50-oneline.txt'))!;
  assert.match(oneline, /^git log: 16 commits/);
  assert.match(oneline, /^fc94219 Match the package smoke check/m);
});

test('git log truncates to a token budget and states how many commits were omitted', () => {
  const raw = Array.from({ length: 300 }, (_, i) =>
    `commit ${(i + 1).toString(16).padStart(40, 'a')}\nAuthor: A B <a@b.c>\nDate:   Sat Oct 3 01:13:52 2026 +0100\n\n    Subject number ${i} with some words\n\n`).join('');
  const out = summarizeGit(['git', 'log'], raw)!;
  assert.ok(bytes(out) <= 2500, `budget respected, got ${bytes(out)}`);
  assert.match(out, /^git log: 300 commits/);
  assert.match(out, /\n\+\d+ more commits omitted, recover with the receipt\n$/);
  const shown = out.split('\n').filter(line => /^[0-9a-f]{7} /.test(line)).length;
  assert.equal(Number(/\+(\d+) more/.exec(out)![1]) + shown, 300);
});

test('git diff --stat is sorted by churn, capped at 25 rows, with the totals line', () => {
  const out = summarizeGit(['git', 'diff', 'HEAD~3', '--stat'], fixture('diff-stat.txt'))!;
  const rows = out.split('\n').filter(line => line.includes(' | '));
  assert.equal(rows.length, 25);
  assert.match(out, /^git diff: 41 files changed, 2253 insertions\(\+\), 276 deletions\(-\)/);
  assert.match(rows[0]!, /raw-vs-fusion\.json \| 477$/);
  const churn = rows.map(row => Number(/\| (\d+)$/.exec(row)![1]));
  assert.deepEqual(churn, [...churn].sort((a, b) => b - a));
  assert.match(out, /\+16 more files omitted, recover with the receipt\n$/);
});

test('git diff --numstat keeps exact additions and deletions', () => {
  const out = summarizeGit(['git', 'diff', 'HEAD~3', '--numstat'], fixture('diff-numstat.txt'))!;
  assert.match(out, /^git diff: 41 files changed, 2253 insertions\(\+\), 276 deletions\(-\)/);
  assert.match(out, /src\/evidence\.ts \| \+26 -133/);
});

test('full git diff patch reports files, hunks and counts but not the patch', () => {
  const raw = fixture('diff-patch.txt');
  const out = summarizeGit(['git', 'diff', 'HEAD~3', '--', 'src/run.ts', 'src/diagnostics.ts'], raw)!;
  assert.equal(out, 'git diff: 2 files, 10 hunks, +85 -36 (patch bodies omitted; files sorted by churn)\nsrc/run.ts: 7 hunks +45 -23\nsrc/diagnostics.ts: 3 hunks +40 -13\n');
});

test('hunk bodies that look like diff headers do not confuse counting', () => {
  const patch = ['diff --git a/x.md b/x.md', 'index 1..2 100644', '--- a/x.md', '+++ b/x.md', '@@ -1,3 +1,3 @@', ' keep',
    '--- looks like a header but is a removed line', '+++ looks like a header but is an added line', ' tail', ''].join('\n');
  assert.equal(summarizeGit(['git', 'diff'], patch), 'git diff: 1 file, 1 hunk, +1 -1 (patch bodies omitted; files sorted by churn)\nx.md: 1 hunk +1 -1\n');
});

test('git status groups counts and caps listed paths', () => {
  const long = summarizeGit(['git', 'status'], fixture('status-long.txt'))!;
  assert.match(long, /^git status: On branch docs\/launch-ready-packaging \| Your branch is up to date/);
  assert.match(long, /\nunstaged 10, untracked 11\n/);
  assert.equal(long.split('\n').filter(line => line.startsWith('  ')).length, 20);
  assert.match(long, /\+1 more paths omitted, recover with the receipt\n$/);
  const short = summarizeGit(['git', 'status', '-sb'], fixture('status-short.txt'))!;
  assert.match(short, /\nunstaged 10, untracked 11\n/);
  assert.match(short, /^git status: docs\/launch-ready-packaging\.\.\.origin/);
});

test('git branch lists names and the current branch', () => {
  const out = summarizeGit(['git', 'branch', '-a'], fixture('branch.txt'))!;
  assert.match(out, /^git branch: 6 branches, current docs\/launch-ready-packaging\n/);
  assert.match(out, /main, remotes\/origin\/HEAD/);
});

test('conservative detection: unknown flags, other programs, mutating forms and odd output fall back', () => {
  const log = fixture('log-50.txt');
  assert.equal(summarizeGit(['git', 'log', '--graph'], log), undefined);
  assert.equal(summarizeGit(['git', 'log', '--format=%H'], log), undefined);
  assert.equal(summarizeGit(['git', '-C', 'x', 'log'], log), undefined);
  assert.equal(summarizeGit(['git', 'blame', 'a.ts'], log), undefined);
  assert.equal(summarizeGit(['hg', 'log'], log), undefined);
  assert.equal(summarizeGit(['git', 'branch', 'newname'], 'x\n'), undefined);
  assert.equal(summarizeGit(['git', 'branch', '-D', 'old'], '* main\n'), undefined);
  assert.equal(summarizeGit(['git', 'log'], 'not a log at all\n'), undefined);
  assert.equal(summarizeGit(['git', 'diff'], 'diff --cc file\n@@@ -1 -1 +1 @@@\n'), undefined);
  assert.ok(summarizeGit(['C:\\Program Files\\Git\\cmd\\git.exe', '--no-pager', 'log', '-50'], log));
});

test('summarizeChannel uses the git summary for stdout receipts, keeps the receipt bytes, and reports omitted bytes', async () => {
  const store = new EvidenceStore();
  const raw = Buffer.from(fixture('log-p-5.txt'));
  const receipt = store.capture({ source: { kind: 'command', cwd: process.cwd(), argv: ['git', 'log', '-p', '-n', '3'], channel: 'stdout' }, bytes: raw });
  const summary = await summarizeChannel(store, receipt);
  assert.ok(summary.informational);
  assert.equal(summary.omittedBytes, raw.length);
  assert.deepEqual(summary.diagnostics, []);
  assert.equal(summary.diagnosticsOmitted, 0);
  const rendered = renderChannelSummary(summary);
  assert.match(rendered, /^git log: /);
  assert.match(rendered, new RegExp(`omittedBytes=${raw.length}\\n$`));
  const page = await store.expand({ id: receipt.id, startByte: 0, maxBytes: 64 });
  assert.equal(page.status, 'ok');
});

test('other commands, stderr channels, truncated captures and small outputs keep the generic path', async () => {
  const store = new EvidenceStore();
  const raw = Buffer.from(fixture('log-50.txt'));
  const source = (argv: string[], channel: 'stdout' | 'stderr') => ({ kind: 'command' as const, cwd: process.cwd(), argv, channel });
  assert.equal((await summarizeChannel(store, store.capture({ source: source(['git', 'log', '--graph'], 'stdout'), bytes: raw }))).informational, undefined);
  assert.equal((await summarizeChannel(store, store.capture({ source: source(['git', 'log'], 'stderr'), bytes: raw }))).informational, undefined);
  assert.equal((await summarizeChannel(store, store.capture({ source: source(['git', 'log'], 'stdout'), bytes: raw, truncated: true }))).informational, undefined);
  const small = await summarizeChannel(store, store.capture({ source: source(['git', 'log'], 'stdout'), bytes: Buffer.from('commit ' + 'a'.repeat(40) + '\n\n    hi\n') }));
  assert.equal(small.informational, undefined);
  assert.match(small.smallText ?? '', /commit a+/);
});
