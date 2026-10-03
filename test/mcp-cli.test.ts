import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { preparePrivateDirectory } from '../src/private-config.js';
import { privateFixtureHome } from './private-fixture.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const isolatedConfigHome = privateFixtureHome('fusion-cli-config-');
process.env.FUSION_CONFIG_HOME = isolatedConfigHome;
after(() => rm(isolatedConfigHome, { recursive: true, force: true }));

test('CLI help works without credentials and doctor never prints configured secrets', () => {
  const help = spawnSync(process.execPath, ['--import', 'tsx', cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /stdio/);
  assert.match(help.stdout, /doctor/);
  const doctor = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TYPESAFE_API_KEY: 'test-secret-never-print',
      JEV_API_KEY: '',
      OPENAI_API_KEY: 'another-secret-never-print',
      FUSION_FALLBACK: 'host',
    },
  });
  assert.equal(doctor.status, 0);
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /test-secret-never-print|another-secret-never-print/);
  assert.equal(JSON.parse(doctor.stdout).providers.jev, 'configured');
  assert.equal(JSON.parse(doctor.stdout).providers.gpt, 'host');
  assert.equal(JSON.parse(doctor.stdout).profile, 'assist');
  assert.deepEqual(JSON.parse(doctor.stdout).mcpTools, ['fusion_assist', 'fusion_inspect', 'fusion_evidence']);
});

test('stdio doctor reports usable local tools with an optional unconfigured Jev provider', () => {
  const doctor = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'stdio'], {
    encoding: 'utf8',
    env: { ...process.env, TYPESAFE_API_KEY: '', FUSION_ENV_FILE: '', FUSION_FALLBACK: 'host' },
  });
  assert.equal(doctor.status, 0);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.status, 'ready');
  assert.equal(report.providers.jev, 'missing');
  assert.equal(report.workspace, 'local');
  assert.deepEqual(report.mcpTools, ['fusion_assist', 'fusion_inspect', 'fusion_evidence']);
  assert.equal(report.liveConnectivity, 'not-tested');
  assert.match(report.warnings[0], /Jev requests/);
  assert.match(report.warnings[0], /workspace tools remain available/);
});

test('CLI loads only an explicitly configured absolute env file', async (t) => {
  const directory = privateFixtureHome('fusion-doctor-env-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(preparePrivateDirectory(join(directory, 'private')), 'provider.env');
  await writeFile(envFile, 'TYPESAFE_API_KEY=explicit-test-secret-never-print\n', { mode: 0o600 });
  const base: NodeJS.ProcessEnv = { ...process.env, FUSION_ENV_FILE: '', FUSION_FALLBACK: 'host' };
  delete base.TYPESAFE_API_KEY;
  const doctor = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'stdio', `--provider-env=${envFile}`], {
    encoding: 'utf8',
    env: base,
  });
  assert.equal(doctor.status, 0);
  assert.equal(JSON.parse(doctor.stdout).providers.jev, 'configured');
  assert.equal(JSON.parse(doctor.stdout).status, 'ready');
  assert.equal(JSON.parse(doctor.stdout).liveConnectivity, 'not-tested');
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /explicit-test-secret-never-print/);
  const relative = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'stdio', '--provider-env=.env'], {
    encoding: 'utf8',
    env: base,
  });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /absolute/);
});

test('saved user env-file path makes the bare doctor command ready across working directories', async (t) => {
  const directory = privateFixtureHome('fusion-saved-env-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(join(isolatedConfigHome, 'fusion-jev-mcp', 'config.json'), { force: true }));
  const envFile = join(preparePrivateDirectory(join(directory, 'private')), 'provider.env');
  await writeFile(envFile, 'TYPESAFE_API_KEY=saved-test-secret-never-print\n', { mode: 0o600 });
  const base: NodeJS.ProcessEnv = { ...process.env, FUSION_FALLBACK: 'host' };
  delete base.TYPESAFE_API_KEY;
  delete base.FUSION_ENV_FILE;
  const saved = spawnSync(process.execPath, ['--import', 'tsx', cli, 'config', 'env-file', envFile], {
    encoding: 'utf8',
    env: base,
  });
  assert.equal(saved.status, 0);
  const doctor = spawnSync(process.execPath, ['--import', tsxImport, cli, 'doctor', 'stdio'], {
    encoding: 'utf8',
    env: base,
    cwd: directory,
  });
  assert.equal(doctor.status, 0);
  assert.equal(JSON.parse(doctor.stdout).status, 'ready');
  assert.equal(JSON.parse(doctor.stdout).providers.jev, 'configured');
  assert.equal(JSON.parse(doctor.stdout).liveConnectivity, 'not-tested');
  assert.doesNotMatch(saved.stdout + saved.stderr + doctor.stdout + doctor.stderr, /saved-test-secret-never-print/);
  const processWins = spawnSync(process.execPath, ['--import', tsxImport, cli, 'doctor', 'stdio'], {
    encoding: 'utf8',
    env: { ...base, TYPESAFE_API_KEY: '' },
    cwd: directory,
  });
  assert.equal(processWins.status, 0);
  assert.equal(JSON.parse(processWins.stdout).status, 'ready');
  assert.equal(JSON.parse(processWins.stdout).providers.jev, 'missing');
  const cleared = spawnSync(process.execPath, ['--import', 'tsx', cli, 'config', 'env-file', '--clear'], {
    encoding: 'utf8',
    env: base,
  });
  assert.equal(cleared.status, 0);
});

test('MCP CLI rejects a paid GPT fallback even when an API key is present', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, FUSION_FALLBACK: 'gpt', OPENAI_API_KEY: 'secret-never-print' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FUSION_FALLBACK=host/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-never-print/);
});

test('HTTP doctor advertises workspace tools only when the server owns a valid root', () => {
  const base = {
    ...process.env,
    TYPESAFE_API_KEY: 'test-key',
    FUSION_FALLBACK: 'host',
    FUSION_HTTP_BEARER_TOKEN: 'local-test-token',
  };
  const routingOnly = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'http'], {
    encoding: 'utf8',
    env: { ...base, FUSION_WORKSPACE_ROOT: '' },
  });
  assert.equal(routingOnly.status, 0);
  assert.equal(JSON.parse(routingOnly.stdout).mcpTools.length, 4);
  assert.equal(JSON.parse(routingOnly.stdout).profile, 'assist');
  assert.equal(JSON.parse(routingOnly.stdout).effectiveProfile, 'core');
  const withWorkspace = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'http'], {
    encoding: 'utf8',
    env: { ...base, FUSION_WORKSPACE_ROOT: projectRoot },
  });
  assert.equal(withWorkspace.status, 0);
  assert.equal(JSON.parse(withWorkspace.stdout).mcpTools.length, 4);
  assert.equal(JSON.parse(withWorkspace.stdout).workspace, 'disabled');
  const optedIn = { ...base, FUSION_HTTP_ENABLE_WORKSPACE: 'true' };
  const exposed = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'http'], {
    encoding: 'utf8',
    env: { ...optedIn, FUSION_WORKSPACE_ROOT: projectRoot },
  });
  assert.equal(exposed.status, 0);
  assert.deepEqual(JSON.parse(exposed.stdout).mcpTools, ['fusion_assist', 'fusion_inspect', 'fusion_evidence']);
  assert.equal(JSON.parse(exposed.stdout).workspace, 'server-root');
  const badRoot = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'http'], {
    encoding: 'utf8',
    env: { ...optedIn, FUSION_WORKSPACE_ROOT: `${projectRoot}/nonexistent-repo` },
  });
  assert.equal(badRoot.status, 1);
  assert.match(badRoot.stderr, /Workspace root is unavailable/);
  const relativeRoot = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'http'], {
    encoding: 'utf8',
    env: { ...optedIn, FUSION_WORKSPACE_ROOT: '.' },
  });
  assert.equal(relativeRoot.status, 1);
  assert.match(relativeRoot.stderr, /must be absolute/);
});

test('full doctor lists every legacy tool in order plus assist and evidence', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, TYPESAFE_API_KEY: 'test-key', FUSION_MCP_PROFILE: 'full', FUSION_FALLBACK: 'host' },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.profile, 'full');
  assert.deepEqual(report.mcpTools, [
    'fusion_repo_overview',
    'fusion_inspect',
    'fusion_list_files',
    'fusion_read_file',
    'fusion_search_text',
    'fusion_git_status',
    'fusion_git_diff',
    'fusion_git_log',
    'fusion_workspace',
    'fusion_choose',
    'fusion_choose_batch',
    'fusion_route',
    'fusion_route_batch',
    'fusion_assist',
    'fusion_evidence',
  ]);
});

test('stdio starts a real MCP session with pure protocol stdout and host escalation', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', cli, 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      TYPESAFE_API_KEY: '',
      OPENAI_API_KEY: 'not-used',
      FUSION_FALLBACK: 'host',
      FUSION_MCP_PROFILE: 'full',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    [
      'fusion_repo_overview',
      'fusion_inspect',
      'fusion_list_files',
      'fusion_read_file',
      'fusion_search_text',
      'fusion_git_status',
      'fusion_git_diff',
      'fusion_git_log',
      'fusion_workspace',
      'fusion_choose',
      'fusion_choose_batch',
      'fusion_route',
      'fusion_route_batch',
      'fusion_assist',
      'fusion_evidence',
    ],
  );
  const result = await client.callTool({
    name: 'fusion_route',
    arguments: {
      task: 'lookup a',
      tools: [
        {
          name: 'lookup',
          description: 'Lookup',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    },
  });
  assert.equal((result.structuredContent as any).decision.status, 'escalate');
  assert.equal((result.structuredContent as any).decision.source, 'host');
  const workspace = await client.callTool({
    name: 'fusion_workspace',
    arguments: { task: 'List files in this workspace' },
  });
  assert.equal((workspace.structuredContent as any).route.decision.status, 'escalate');
  assert.equal((workspace.structuredContent as any).execution, undefined);
  const direct = await client.callTool({
    name: 'fusion_read_file',
    arguments: { root: projectRoot, path: 'package.json', maxLines: 3 },
  });
  assert.equal(direct.isError, undefined);
  assert.equal(direct.structuredContent, undefined);
  assert.match((direct.content as any)[0].text, /1: \{/);
  assert.match((direct.content as any)[0].text, /nextLine=4/);
  const unsupported = await client.callTool({
    name: 'fusion_route',
    arguments: { task: 'draft', strategy: 'gpt-only', tools: [] },
  });
  assert.equal(unsupported.isError, true);
});

test('stdio workspace roots are limited to the configured root allowlist', async (t) => {
  const allowed = await mkdtemp(join(tmpdir(), 'fusion-allowed-root-'));
  const denied = await mkdtemp(join(tmpdir(), 'fusion-denied-root-'));
  t.after(async () => {
    await rm(allowed, { recursive: true, force: true });
    await rm(denied, { recursive: true, force: true });
  });
  await writeFile(join(allowed, 'allowed.txt'), 'allowed');
  await writeFile(join(denied, 'jev.env'), 'TYPESAFE_API_KEY=must-not-be-readable');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', cli, 'stdio'],
    env: {
      PATH: process.env.PATH ?? '',
      FUSION_FALLBACK: 'host',
      FUSION_MCP_PROFILE: 'full',
      FUSION_WORKSPACE_ROOT: projectRoot,
      FUSION_WORKSPACE_ALLOWED_ROOTS: allowed,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-root-allowlist-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const allowedRead = await client.callTool({
    name: 'fusion_read_file',
    arguments: { root: allowed, path: 'allowed.txt' },
  });
  assert.match((allowedRead.content as any)[0].text, /allowed/);
  const nestedRoot = await client.callTool({
    name: 'fusion_list_files',
    arguments: { root: join(projectRoot, 'src') },
  });
  assert.equal(nestedRoot.isError, true);
  assert.equal((nestedRoot.structuredContent as any).error.code, 'INVALID_PATH');
  const deniedRead = await client.callTool({ name: 'fusion_read_file', arguments: { root: denied, path: 'jev.env' } });
  assert.equal(deniedRead.isError, true);
  assert.equal((deniedRead.structuredContent as any).error.code, 'INVALID_PATH');
  assert.doesNotMatch(JSON.stringify(deniedRead), /must-not-be-readable/);
});
