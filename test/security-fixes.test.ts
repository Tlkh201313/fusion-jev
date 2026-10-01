import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createFusionMcpServer, type RoutingService } from '../src/mcp.js';
import { EvidenceStore } from '../src/evidence.js';
import { WorkspaceService } from '../src/workspace.js';
import { isSecretName, redactSecrets, redactTokens } from '../src/secrets.js';

const router: RoutingService = {
  async route() { throw new Error('No provider calls expected'); },
  async routeBatch() { throw new Error('No provider calls expected'); },
};
const command = { kind: 'command' as const, cwd: process.cwd(), argv: ['node'], channel: 'stdout' as const };

test('redaction stays linear on whitespace-heavy untrusted input', () => {
  const input = Buffer.from(' \n'.repeat(512 * 1024));
  const started = performance.now();
  const receipt = new EvidenceStore().capture({ source: command, bytes: input });
  assert.equal(receipt.redacted, false);
  assert.ok(performance.now() - started < 2000, 'redaction of 1 MiB of whitespace must not backtrack quadratically');
});

test('common credential shapes and assignment forms are redacted', () => {
  const secrets = {
    github: 'ghp_' + 'a'.repeat(36), githubPat: 'github_pat_' + 'B'.repeat(30), npm: 'npm_' + 'c'.repeat(36),
    aws: 'AKIA' + 'D'.repeat(16), anthropic: 'sk-ant-' + 'e'.repeat(30), openai: 'sk-proj-' + 'f'.repeat(30),
    jwt: 'eyJ' + 'g'.repeat(12) + '.eyJ' + 'h'.repeat(12) + '.' + 'i'.repeat(12),
  };
  const lines = [
    `export GITHUB_TOKEN=plain-export-value`, `declare -x DB_PASSWORD="declared-value"`, `  OPENAI_API_KEY: 'node-inspect-value',`,
    `> Authorization: Bearer curl-verbose-value`, `postgres://admin:url-password-value@db.example:5432/app`,
    ...Object.values(secrets).map(value => `token in prose ${value} end`),
    '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', '-----END OPENSSH PRIVATE KEY-----',
  ];
  const safe = redactSecrets(lines.join('\n'));
  for (const leaked of ['plain-export-value', 'declared-value', 'node-inspect-value', 'curl-verbose-value', 'url-password-value',
    'b3BlbnNzaC1rZXktdjEAAAAA', ...Object.values(secrets)]) assert.doesNotMatch(safe, new RegExp(leaked), leaked);
  assert.equal(safe.split('\n').length, lines.length, 'private key blocks keep their line count');
  assert.match(safe, /token in prose \[REDACTED\] end/);
  assert.equal(redactSecrets('MAX_TOKENS=5\nconst token = load();\n'), 'MAX_TOKENS=5\nconst token = load();\n');
});

test('this process\'s own credential values are redacted wherever they appear', t => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'plain-opaque-credential-1234';
  t.after(() => { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; });
  assert.equal(redactTokens('value=plain-opaque-credential-1234;'), 'value=[REDACTED];');
});

test('credential files are excluded from workspace access', async t => {
  for (const name of ['.env', '.envrc', '.env-local', '.git-credentials', '.netrc', '.pgpass', '.pypirc', 'id_ed25519', 'server.pem', '.docker', '.kube'])
    assert.equal(isSecretName(name), true, name);
  for (const name of ['src', 'package.json', 'id_rsa.pub', 'environment.ts']) assert.equal(isSecretName(name), false, name);
  const root = await mkdtemp(join(tmpdir(), 'fusion-secret-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.git-credentials'), 'https://user:pw@example.invalid\n');
  await writeFile(join(root, 'notes.txt'), `key ${'ghp_' + 'z'.repeat(36)}\n`);
  const service = new WorkspaceService(root, router);
  await assert.rejects(service.read('.git-credentials'));
  const read = await service.read('notes.txt');
  assert.equal(read.lines[0]!.text, 'key [REDACTED]');
  const listed = await service.list('.');
  assert.doesNotMatch(JSON.stringify(listed), /git-credentials/);
});

test('read-only Git inspection never runs repository filter drivers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-git-filter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet'); git('config', 'user.name', 'Filter Fixture'); git('config', 'user.email', 'filter@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'original\n');
  git('add', 'a.txt'); git('commit', '--quiet', '-m', 'init');
  const marker = join(root, 'PWNED');
  git('config', 'filter.evil.clean', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdin.pipe(process.stdout)"`);
  git('config', 'filter.evil.process', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`);
  await writeFile(join(root, '.git', 'info', 'attributes'), '* filter=evil\n');
  const later = new Date(Date.now() + 5000);
  await utimes(join(root, 'a.txt'), later, later);
  const service = new WorkspaceService(root, router);
  await service.git('status');
  await writeFile(join(root, 'a.txt'), 'changed\n');
  await service.git('diff');
  await assert.rejects(access(marker), 'filter driver must not execute');
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'changed\n');
});

test('tools hidden by the assist profile cannot be called', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-hidden-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createFusionMcpServer({ router, config: loadConfig({ FUSION_MCP_PROFILE: 'assist' }), workspace: new WorkspaceService(root, router) });
  const client = new Client({ name: 'hidden-tools', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(listed, ['fusion_assist', 'fusion_evidence', 'fusion_inspect']);
  for (const tool of listed) {
    const schema = (await client.listTools()).tools.find(item => item.name === tool)!.inputSchema as Record<string, unknown>;
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) assert.equal(schema[keyword], undefined, `${tool} ${keyword}`);
  }
  const hidden = await client.callTool({ name: 'fusion_route_batch', arguments: { requests: [] } }).catch(error => ({ isError: true, error }));
  assert.equal(hidden.isError, true);
});
