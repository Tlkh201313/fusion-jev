import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
test('native Claude and portable Codex manifests keep distinct host APIs', () => {
  const cc = join(root, 'plugin/fusion-jev-claude/.claude-plugin/plugin.json');
  const codex = join(root, 'plugin/fusion-jev/plugin.json');
  assert.ok(existsSync(cc), 'native Claude manifest exists');
  assert.ok(existsSync(codex), 'portable Codex manifest exists');
  const manifest = JSON.parse(readFileSync(cc, 'utf8'));
  assert.equal(manifest.name, 'fusion-jev');
  const mcp = JSON.parse(readFileSync(join(root, 'plugin/fusion-jev-claude/.mcp.json'), 'utf8')).mcpServers.fusion;
  assert.equal(mcp.command, 'fusion-jev');
  assert.deepEqual(mcp.args, ['stdio']);
  assert.equal(mcp.env.FUSION_FALLBACK, 'host');
  assert.equal(mcp.env_vars, undefined, 'Claude uses env, not Codex env_vars');
  assert.equal(JSON.parse(readFileSync(codex, 'utf8')).name, 'fusion-jev');
});

test('Claude SessionStart gives short Fusion guidance without overriding permissions', () => {
  const script = join(root, 'plugin/fusion-jev-claude/scripts/session-start.cjs');
  assert.ok(existsSync(script), 'bootstrap script exists');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', input: '{"hook_event_name":"SessionStart"}' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /fusion-jev run/);
  assert.match(output.hookSpecificOutput.additionalContext, /Claude/);
  assert.ok(Buffer.byteLength(result.stdout) < 1200);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
});
