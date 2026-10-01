import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { recordUsage } from '../src/providers/http.js';
import { EvidenceStore } from '../src/evidence.js';
import { summarizeChannel } from '../src/command-summary.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');

test('exact provider token counts with unknown prices remain cost-uncertain', () => {
  const usage = recordUsage('jev', loadConfig({}).jev, 'jev', { inputTokens: 120, outputTokens: 10 });
  assert.equal(usage.estimated, false);
  assert.equal(usage.costUncertain, true);
});

test('explicit zero provider prices represent a known free provider', () => {
  const config = loadConfig({ JEV_INPUT_USD_PER_MILLION: '0', JEV_CACHED_INPUT_USD_PER_MILLION: '0', JEV_OUTPUT_USD_PER_MILLION: '0' });
  const usage = recordUsage('jev', config.jev, 'jev', { inputTokens: 120, outputTokens: 10 });
  assert.equal(usage.costUncertain, false);
  assert.equal(usage.estimatedCostUsd, 0);
});

test('CLI command receipts expand through a separate stdio MCP process', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fusion cross process '));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const env = { ...process.env, LOCALAPPDATA: cache, XDG_CACHE_HOME: cache, FUSION_CONFIG_HOME: cache,
    TYPESAFE_API_KEY: '', FUSION_ENV_FILE: '', FUSION_FALLBACK: 'host', FUSION_MCP_PROFILE: 'assist' };
  const command = spawnSync(process.execPath, ['--import', tsx, cli, 'run', '--', process.execPath,
    '-e', 'process.stdout.write("recover me exactly\\n")'], { encoding: 'utf8', env });
  assert.equal(command.status, 0, command.stderr);
  const id = /stdout=([\da-f-]{36})/.exec(command.stdout)?.[1];
  assert.ok(id, command.stdout);
  const client = new Client({ name: 'cross-process-evidence', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', tsx, cli, 'stdio'], env, stderr: 'pipe' }));
  const result = await client.callTool({ name: 'fusion_evidence', arguments: { action: 'get', id } });
  const page = result.structuredContent as any;
  assert.equal(page.status, 'ok');
  assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), 'recover me exactly\n');
  const utf8 = await client.callTool({ name: 'fusion_evidence', arguments: { action: 'get', id, format: 'utf8' } });
  assert.equal(utf8.isError, undefined);
  assert.equal((utf8.structuredContent as any).encoding, 'utf8');
  assert.equal((utf8.structuredContent as any).dataBase64, undefined);
  assert.equal((utf8.structuredContent as any).preview, undefined);
  assert.match((utf8.content as any)[0].text, /recover me exactly\n$/);
  const unicode = spawnSync(process.execPath, ['--import', tsx, cli, 'run', '--', process.execPath,
    '-e', 'process.stdout.write("\\uFEFF🔬\\n")'], { encoding: 'utf8', env });
  const unicodeId = /stdout=([\da-f-]{36})/.exec(unicode.stdout)?.[1];
  assert.ok(unicodeId);
  const exactText = await client.callTool({ name: 'fusion_evidence', arguments: { action: 'get', id: unicodeId, format: 'utf8' } });
  assert.ok((exactText.content as any)[0].text.endsWith('\uFEFF🔬\n'), 'UTF-8 preserves the captured BOM');
  const split = await client.callTool({ name: 'fusion_evidence', arguments: { action: 'get', id: unicodeId, format: 'utf8', maxBytes: 1 } });
  assert.equal((split.structuredContent as any).encoding, 'base64');
  assert.deepEqual(Buffer.from((split.structuredContent as any).dataBase64, 'base64'), Buffer.from('\uFEFF').subarray(0, 1));
});

test('compact commands surface diagnostics after the first page with exact locations', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fusion tail diagnostics '));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const text = 'noise\n'.repeat(4000) + 'file.ts(3,4): error TS2345: expected string, received number\n';
  const command = spawnSync(process.execPath, ['--import', tsx, cli, 'run', '--', process.execPath,
    '-e', `process.stderr.write(${JSON.stringify(text)}); process.exitCode = 1`], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: cache, XDG_CACHE_HOME: cache },
  });
  assert.equal(command.status, 1);
  assert.match(command.stdout + command.stderr, /expected string, received number/);
  assert.match(command.stdout + command.stderr, /file\.ts:3:4/);
  assert.match(command.stdout + command.stderr, /omitted/);
});

test('raw CLI preserves both streams without initializing an unused evidence cache', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'fusion raw cache '));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const command = spawnSync(process.execPath, ['--import', tsx, cli, 'run', '--raw', '--', process.execPath,
    '-e', 'process.stdout.write("small exact\\n");process.stderr.write("warning\\n")'], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: cache, XDG_CACHE_HOME: cache },
  });
  assert.equal(command.status, 0);
  assert.equal(command.stdout, 'small exact\n');
  assert.equal(command.stderr, 'warning\n');
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(join(cache, 'fusion-jev-mcp', 'evidence')));
});

test('binary log lines do not shift later diagnostic byte ranges', async () => {
  const store = new EvidenceStore();
  const bytes = Buffer.concat([Buffer.from([0xff, 10]), Buffer.from('file.ts(3,4): error TS2345: exact diagnostic\n')]);
  const receipt = store.capture({ source: { kind: 'command', cwd: process.cwd(), argv: ['binary-log'], channel: 'stderr' }, bytes });
  const summary = await summarizeChannel(store, receipt);
  assert.equal(summary.diagnostics[0]?.startByte, 2);
  assert.equal((summary as any).unparsedBytes, 2);
});

test('large failure corpora keep bounded summaries and exact omitted counts', async () => {
  const store = new EvidenceStore();
  const receipt = store.capture({ source: { kind: 'command', cwd: process.cwd(), argv: ['many-failures'], channel: 'stderr' },
    bytes: Buffer.from('not ok 1 - failure\n'.repeat(150_000)) });
  const summary = await summarizeChannel(store, receipt);
  assert.equal(summary.diagnostics.length, 4);
  assert.equal(summary.diagnosticsOmitted, 149_996);
});
