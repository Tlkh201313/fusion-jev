import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withTempDir } from './helpers/tmp.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'plugin/fusion-jev-claude/scripts/pretool.cjs');
const sessionScript = join(root, 'plugin/fusion-jev-claude/scripts/session-start.cjs');

function run(event: unknown, env: Record<string, string> = {}, raw?: string, file = script) {
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    input: raw ?? JSON.stringify(event),
    env: { ...process.env, FUSION_HOOKS: '', FUSION_READ_LINES: '', FUSION_READ_BYTES: '', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const out = result.stdout.trim();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

const sid = () => `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
function withProject<T>(fn: (dir: string) => T): T {
  return withTempDir('fusion-hooks-', (dir) => {
    writeFileSync(join(dir, 'big.ts'), 'x\n'.repeat(500));
    writeFileSync(join(dir, 'wide.ts'), 'y'.repeat(30000));
    writeFileSync(join(dir, 'small.ts'), 'const a = 1;\n');
    writeFileSync(join(dir, 'big.pdf'), 'x\n'.repeat(500));
    return fn(dir);
  });
}
const read = (
  dir: string,
  file: string,
  session: string,
  extra: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
) => ({
  hook_event_name: 'PreToolUse',
  session_id: session,
  cwd: dir,
  tool_name: 'Read',
  tool_input: { file_path: file, ...input },
  ...extra,
});

test('Read: denies a large whole-file read once per file, then allows the retry', () => {
  withProject((dir) => {
    const s = sid();
    const first = run(read(dir, join(dir, 'big.ts'), s));
    assert.equal(first.hookEventName, 'PreToolUse');
    assert.equal(first.permissionDecision, 'deny');
    assert.ok(first.permissionDecisionReason.split(/\s+/).length <= 60, 'reason stays short');
    assert.match(first.permissionDecisionReason, /outline/);
    assert.equal(run(read(dir, join(dir, 'big.ts'), s)), null, 'second attempt passes');
    assert.equal(
      run(read(dir, 'wide.ts', s))?.permissionDecision,
      'deny',
      'relative path, byte threshold, different file',
    );
    assert.equal(run(read(dir, join(dir, 'big.ts'), sid()))?.permissionDecision, 'deny', 'new session denies again');
  });
});

test('Read: never denies small files, ranged reads, binaries, outside paths or missing files', () => {
  withProject((dir) => {
    const s = sid();
    assert.equal(run(read(dir, join(dir, 'small.ts'), s)), null);
    assert.equal(run(read(dir, join(dir, 'big.ts'), s, {}, { offset: 1, limit: 50 })), null);
    assert.equal(run(read(dir, join(dir, 'big.ts'), s, {}, { limit: 50 })), null);
    assert.equal(run(read(dir, join(dir, 'big.pdf'), s)), null);
    assert.equal(run(read(dir, join(dir, 'missing.ts'), s)), null);
    assert.equal(run(read(dir, join(root, 'package.json'), s)), null, 'outside the project cwd');
    assert.equal(run(read(dir, join(dir, 'big.ts'), s, {}, { pages: '1-2' })), null);
  });
});

test('Read: thresholds are configurable and an earlier outline in the transcript skips the deny', () => {
  withProject((dir) => {
    assert.equal(run(read(dir, join(dir, 'big.ts'), sid()), { FUSION_READ_LINES: '1000' }), null);
    assert.equal(run(read(dir, join(dir, 'small.ts'), sid()), { FUSION_READ_LINES: '1' })?.permissionDecision, 'deny');
    assert.equal(run(read(dir, join(dir, 'wide.ts'), sid()), { FUSION_READ_BYTES: '100000' }), null);
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcript,
      `${JSON.stringify({ tool: 'mcp__plugin_fusion-jev_fusion__fusion_inspect', input: { ops: [{ op: 'outline', path: 'big.ts' }] } })}\n`,
    );
    assert.equal(run(read(dir, join(dir, 'big.ts'), sid(), { transcript_path: transcript })), null);
    assert.equal(
      run(read(dir, join(dir, 'wide.ts'), sid(), { transcript_path: transcript }))?.permissionDecision,
      'deny',
    );
  });
});

test('Read: Windows-style separators resolve on Windows', { skip: process.platform !== 'win32' }, () => {
  withProject((dir) => {
    const win = join(dir, 'big.ts').replace(/\//g, '\\');
    assert.equal(run(read(dir.toUpperCase(), win, sid()))?.permissionDecision, 'deny', 'case-insensitive cwd match');
    assert.equal(run(read(dir, 'C:\\Windows\\System32\\drivers\\etc\\hosts', sid())), null);
  });
});

test('Grep: advises on unbounded content searches, never decides, and is capped per session', () => {
  const s = sid();
  const grep = (input: Record<string, unknown>) =>
    run({ hook_event_name: 'PreToolUse', session_id: s, cwd: root, tool_name: 'Grep', tool_input: input });
  assert.equal(grep({ pattern: 'function foo', output_mode: 'files_with_matches' }), null);
  assert.equal(grep({ pattern: 'foo', output_mode: 'content', head_limit: 20 }), null);
  const advice = grep({ pattern: 'foo', output_mode: 'content' });
  assert.match(advice.additionalContext, /fusion_inspect op grep/);
  assert.equal(advice.permissionDecision, undefined);
  assert.ok(grep({ pattern: '.*' }));
  assert.ok(grep({ pattern: 'bar', output_mode: 'content' }));
  assert.equal(grep({ pattern: 'baz', output_mode: 'content' }), null, 'capped at three notes');
});

test('Bash: advises on noisy commands only when not already wrapped', () => {
  const s = sid();
  const bash = (command: string) =>
    run({ hook_event_name: 'PreToolUse', session_id: s, cwd: root, tool_name: 'Bash', tool_input: { command } });
  assert.equal(bash('ls -la'), null);
  assert.equal(bash('git status'), null);
  assert.equal(bash('fusion-jev run -- npm test'), null);
  assert.equal(bash('npx -y fusion-jev@0.3.0 run -- pytest'), null);
  assert.equal(bash('npm test | tail -20'), null);
  assert.equal(bash('git diff --stat'), null);
  assert.equal(bash('git diff HEAD -- src/cli.ts'), null);
  assert.equal(bash('git diff src/cli.ts'), null);
  const advice = bash('cd app && npm run build');
  assert.match(advice.additionalContext, /fusion-jev run -- /);
  assert.match(advice.additionalContext, /npx -y fusion-jev@\d+\.\d+\.\d+ run/);
  assert.equal(advice.permissionDecision, undefined);
  assert.ok(bash('git diff'));
  assert.ok(bash('cargo test'));
  assert.equal(bash('pytest -q'), null, 'capped at three notes');
});

test('Bash: recognizes the documented noisy command families', () => {
  const s = sid();
  for (const command of [
    'npm test',
    'pnpm run lint',
    'npx tsc --noEmit',
    'python -m pytest',
    'go test ./...',
    'git log -p -5',
    'git diff HEAD~1',
  ]) {
    const advice = run({
      hook_event_name: 'PreToolUse',
      session_id: `${s}${command.length}`,
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.ok(advice?.additionalContext, command);
  }
});

test('hooks fail open: off switch, malformed, empty, unknown and mistyped input', () => {
  withProject((dir) => {
    const big = read(dir, join(dir, 'big.ts'), sid());
    assert.equal(run(big, { FUSION_HOOKS: 'off' }), null);
    assert.equal(run(big, { FUSION_HOOKS: '0' }), null);
    assert.equal(run(undefined, {}, '{not json'), null);
    assert.equal(run(undefined, {}, ''), null);
    assert.equal(run(undefined, {}, 'null'), null);
    assert.equal(run({ tool_name: 'Read' }), null);
    assert.equal(run({ tool_name: 'Read', tool_input: 'x' }), null);
    assert.equal(run({ tool_name: 'Read', tool_input: { file_path: 42 }, session_id: sid(), cwd: dir }), null);
    assert.equal(
      run({ tool_name: 'Write', tool_input: { file_path: join(dir, 'big.ts') }, session_id: sid(), cwd: dir }),
      null,
    );
    assert.equal(run({ ...big, hook_event_name: 'PostToolUse' }), null);
    assert.equal(run({ ...big, session_id: undefined }), null, 'no session id means no state, so no deny');
    assert.equal(run({ ...big, cwd: join(dir, 'nope') }), null);
  });
});

test('the only decision any hook output may carry is deny', () => {
  withProject((dir) => {
    const outputs = [
      run(read(dir, join(dir, 'big.ts'), sid())),
      run({
        hook_event_name: 'PreToolUse',
        session_id: sid(),
        cwd: dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      }),
      run({
        hook_event_name: 'PreToolUse',
        session_id: sid(),
        cwd: dir,
        tool_name: 'Grep',
        tool_input: { pattern: 'x', output_mode: 'content' },
      }),
    ];
    for (const out of outputs) assert.ok(out.permissionDecision === undefined || out.permissionDecision === 'deny');
    const source = readFileSync(script, 'utf8');
    assert.doesNotMatch(source, /permissionDecision: '(allow|ask|defer)'|updatedInput/);
  });
});

test('SessionStart hint is at most 500 characters, keeps the run forms, and honours the off switch', () => {
  const out = run(undefined, {}, '{"hook_event_name":"SessionStart"}', sessionScript);
  assert.equal(out.hookEventName, 'SessionStart');
  assert.ok(out.additionalContext.length <= 500, String(out.additionalContext.length));
  assert.match(
    out.additionalContext,
    /fusion-jev run -- program argv\.\.\. if installed globally, else npx -y fusion-jev@\d+\.\d+\.\d+ run -- program argv/,
  );
  assert.match(out.additionalContext, /'--'/);
  assert.equal(run(undefined, { FUSION_HOOKS: 'off' }, '{}', sessionScript), null);
});

test('hooks.json registers the SessionStart and PreToolUse hooks with short timeouts', () => {
  const { hooks } = JSON.parse(readFileSync(join(root, 'plugin/fusion-jev-claude/hooks/hooks.json'), 'utf8'));
  const pre = hooks.PreToolUse[0];
  assert.equal(pre.matcher, 'Read|Grep|Bash');
  assert.ok(pre.hooks[0].timeout <= 3);
  assert.match(pre.hooks[0].command, /pretool\.cjs/);
});
