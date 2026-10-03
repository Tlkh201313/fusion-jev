import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../plugin/fusion-jev-claude/scripts/routine-pretool.cjs', import.meta.url));
const run = (tool_name: string, tool_input: object, off = '') => {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input }),
    env: { ...process.env, FUSION_HOOKS: off },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
};
test('routine hook reminds small reads and short commands without permission decisions', () => {
  for (const [tool, args] of [
    ['Read', { file_path: 'README.md', limit: 5 }],
    ['Grep', { pattern: 'name' }],
    ['Glob', { pattern: '*.ts' }],
    ['Bash', { command: 'node --version' }],
  ] as const) {
    const output = run(tool, args);
    assert.match(output.additionalContext, /fusion_assist/);
    assert.equal(output.permissionDecision, undefined);
    assert.equal(output.updatedInput, undefined);
  }
});
test('routine hook leaves wrapped commands, nontext reads and disabled hooks alone', () => {
  assert.equal(run('Bash', { command: 'fusion-jev run --raw -- node --version' }), null);
  assert.equal(run('Bash', { command: 'npx -y fusion-jev@0.3.0 run -- node --version' }), null);
  assert.equal(run('Read', { file_path: 'image.png' }), null);
  assert.equal(run('Read', { file_path: 'README.md' }, 'off'), null);
});
