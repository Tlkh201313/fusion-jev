import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const version: string = readJson('package.json').version;
test('native Claude and portable Codex manifests keep distinct host APIs', () => {
  const cc = join(root, 'plugin/fusion-jev-claude/.claude-plugin/plugin.json');
  const codex = join(root, 'plugin/fusion-jev/plugin.json');
  assert.ok(existsSync(cc), 'native Claude manifest exists');
  assert.ok(existsSync(codex), 'portable Codex manifest exists');
  const manifest = JSON.parse(readFileSync(cc, 'utf8'));
  assert.equal(manifest.name, 'fusion-jev');
  const mcp = JSON.parse(readFileSync(join(root, 'plugin/fusion-jev-claude/.mcp.json'), 'utf8')).mcpServers.fusion;
  assert.equal(mcp.command, 'npx');
  assert.deepEqual(mcp.args, ['-y', `fusion-jev@${version}`, 'stdio']);
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
  assert.match(output.hookSpecificOutput.additionalContext, /npx -y fusion-jev run/, 'works without a global install');
  assert.match(output.hookSpecificOutput.additionalContext, /fusion-jev run if installed globally/);
  assert.match(output.hookSpecificOutput.additionalContext, /Claude/);
  assert.ok(Buffer.byteLength(result.stdout) < 1200);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
});

test('every shipped version string and plugin launch pin equals package.json', () => {
  assert.match(version, /^\d+\.\d+\.\d+/);
  const server = readJson('server.json');
  assert.equal(server.version, version);
  assert.deepEqual(server.packages.map((pkg: { version: string }) => pkg.version), [version]);
  assert.equal(server.packages[0].identifier, 'fusion-jev');
  assert.equal(readJson('package.json').mcpName, server.name, 'registry name must match mcpName');
  for (const manifest of ['plugin/fusion-jev/plugin.json', 'plugin/fusion-jev/.codex-plugin/plugin.json',
    'plugin/fusion-jev-claude/.claude-plugin/plugin.json']) assert.equal(readJson(manifest).version, version, manifest);
  for (const config of ['plugin/fusion-jev/.mcp.json', 'plugin/fusion-jev-claude/.mcp.json']) {
    assert.deepEqual(readJson(config).mcpServers.fusion.args, ['-y', `fusion-jev@${version}`, 'stdio'], config);
  }
  assert.ok(readFileSync(join(root, 'src/mcp.ts'), 'utf8').includes(`title: 'Fusion Jev', version: '${version}'`), 'MCP server version');
});

test('sync-version --check passes for the repository and rejects a mismatched tag', () => {
  const script = join(root, 'scripts/sync-version.mjs');
  const ok = spawnSync(process.execPath, [script, '--check', '--tag', `v${version}`], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [script, '--check', '--tag', 'v999.0.0'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not match/);
});

test('host-facing command guidance works without a global fusion-jev binary', () => {
  for (const manifest of ['plugin/fusion-jev/plugin.json', 'plugin/fusion-jev/.codex-plugin/plugin.json']) {
    const prompt = JSON.stringify(readJson(manifest));
    assert.match(prompt, /npx -y fusion-jev run -- program argv/, manifest);
  }
});
