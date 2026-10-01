import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../plugin/fusion-jev-claude/scripts/pre-bash.cjs', import.meta.url));
const { decide } = createRequire(import.meta.url)(script) as {
  decide: (input: unknown, env: Record<string, string | undefined>) => { hookSpecificOutput: Record<string, any> } | undefined;
};
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string;
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command, description: 'Run tests', timeout: 120000 } });

test('auto-wrap is off unless explicitly enabled', async t => {
  const config = await mkdtemp(join(tmpdir(), 'fusion-hook-config-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const env = { FUSION_CONFIG_HOME: config, PATH: '' };
  assert.equal(decide(bash('npm test'), env), undefined);
  await mkdir(join(config, 'fusion-jev-mcp'));
  await writeFile(join(config, 'fusion-jev-mcp', 'auto-wrap.json'), '{"enabled":true}\n');
  assert.ok(decide(bash('npm test'), env));
  assert.equal(decide(bash('npm test'), { ...env, FUSION_AUTO_WRAP: '0' }), undefined);
});

test('only simple, known-noisy commands are rewritten, keeping other input fields', () => {
  const env = { FUSION_AUTO_WRAP: '1', PATH: '' };
  const wrapped = decide(bash('npm run build'), env)!.hookSpecificOutput;
  assert.equal(wrapped.hookEventName, 'PreToolUse');
  assert.equal(wrapped.permissionDecision, undefined, 'the hook never decides permissions');
  assert.deepEqual(wrapped.updatedInput, { command: `npx -y --package=fusion-jev-mcp@${version} fusion-jev run -- npm run build`,
    description: 'Run tests', timeout: 120000 });
  for (const command of ['cargo test --workspace', 'pytest tests/unit', 'go test ./...', 'npx tsc --noEmit', 'make'])
    assert.ok(decide(bash(command), env), command);
  for (const command of ['npm test | head', 'npm test && rm -rf x', 'npm test > out.txt', 'FOO=$HOME npm test', 'npm test "a b"',
    'cd app; npm test', 'rm -rf build', 'git status', 'npm install', 'echo `npm test`', 'npm test\nrm x', 'pytest *.py'])
    assert.equal(decide(bash(command), env), undefined, command);
  assert.equal(decide({ tool_name: 'Read', tool_input: { command: 'npm test' } }, env), undefined);
});

test('a fusion-jev binary on PATH is preferred over npx', { skip: process.platform === 'win32' }, async t => {
  const bin = await mkdtemp(join(tmpdir(), 'fusion-hook-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, 'fusion-jev'), '#!/bin/sh\n');
  await chmod(join(bin, 'fusion-jev'), 0o755);
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify(bash('npm test')), encoding: 'utf8',
    env: { ...process.env, FUSION_AUTO_WRAP: '1', PATH: bin + delimiter + (process.env.PATH ?? '') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command, 'fusion-jev run -- npm test');
  const ignored = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8', env: { ...process.env, FUSION_AUTO_WRAP: '1' } });
  assert.equal(ignored.status, 0);
  assert.equal(ignored.stdout, '');
});
