import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createFusionMcpServer, type RoutingService } from '../src/mcp.js';
import { WorkspaceService } from '../src/workspace.js';
import { EvidenceStore } from '../src/evidence.js';
import type { RouteRequest, RouteResult } from '../src/types.js';
import { deferred } from './deferred.js';

function selecting(action: string, seen: RouteRequest[]): RoutingService {
  return {
    async route(request): Promise<RouteResult> {
      seen.push(request);
      const candidate = request.candidates?.find((item) => item.tool === action);
      return {
        decision: candidate
          ? {
              status: 'selected',
              source: 'jev',
              candidateId: candidate.id,
              call: { tool: candidate.tool, arguments: candidate.arguments },
            }
          : { status: 'escalate', source: 'host', reason: 'model_escalated' },
        usage: [],
        latencyMs: 1,
      };
    },
    async routeBatch() {
      throw new Error('not used');
    },
  };
}

test('inspection distinguishes scoped staged and unstaged Git changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion staged git '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init');
  await writeFile(join(root, 'note.txt'), 'original\n');
  git('add', 'note.txt');
  git('-c', 'user.name=Fusion Test', '-c', 'user.email=fusion@example.invalid', 'commit', '-m', 'fixture');
  await writeFile(join(root, 'note.txt'), 'staged\n');
  git('add', 'note.txt');
  await writeFile(join(root, 'note.txt'), 'unstaged\n');
  const router = selecting('unknown', []);
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
  });
  const client = new Client({ name: 'staged-git', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: 'fusion_inspect',
    arguments: {
      requests: [
        { action: 'git_diff', staged: true, path: 'note.txt' },
        { action: 'git_diff', path: 'note.txt' },
      ],
    },
  });
  assert.equal(result.isError, undefined);
  const text = (result.content as any)[0].text;
  assert.match(text, /\+staged/);
  assert.match(text, /\+unstaged/);
  const refs = (result.structuredContent as any).evidenceRefs;
  assert.ok(refs[0].receipt.source.argv.includes('--cached'));
  assert.ok(!refs[1].receipt.source.argv.includes('--cached'));
});

test('repository search respects Git ignore rules and keeps explicitly unignored sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion git ignore '));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init'], { cwd: root }).status, 0);
  await mkdir(join(root, 'generated'));
  await writeFile(join(root, '.gitignore'), 'generated/*\n!generated/keep.ts\n');
  await writeFile(join(root, 'generated', 'noise.ts'), 'needle ignored\n');
  await writeFile(join(root, 'generated', 'keep.ts'), 'needle kept\n');
  const service = new WorkspaceService(root, selecting('unknown', []));
  const result = await service.search('needle');
  assert.deepEqual(
    result.matches.map((item) => item.path),
    ['generated/keep.ts'],
  );
  assert.equal((result as any).ignoreRules, 'git');
  await writeFile(join(root, 'fresh.ts'), 'needle new\n');
  const refreshed = await service.search('needle');
  assert.ok(
    refreshed.matches.some((item) => item.path === 'fresh.ts'),
    'inventory revalidates after new files',
  );
});

test('scoped Git diff includes deleted files while retaining path boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion deleted git '));
  const external = await mkdtemp(join(tmpdir(), 'fusion outside git '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  git('init');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'deleted.txt'), 'original\n');
  git('add', '.');
  git('-c', 'user.name=Fusion Test', '-c', 'user.email=fusion@example.invalid', 'commit', '-m', 'fixture');
  await rm(join(root, 'nested'), { recursive: true });
  git('add', '-u');
  const service = new WorkspaceService(root, selecting('unknown', []));
  const diff = await service.git('diff', undefined, { staged: true, path: 'nested/deleted.txt' });
  assert.match(diff.text, /-original/);
  const { AssistanceService } = await import('../src/assist.js');
  const assist = new AssistanceService(service, selecting('unknown', []), new EvidenceStore());
  const assisted = await assist.assist({ task: 'git diff staged', scope: 'nested/deleted.txt' });
  assert.equal(assisted.actions[0]?.kind, 'git_diff');
  assert.match(assisted.actions[0]!.summary, /-original/);
  await symlink(external, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['../outside.txt', 'redirect/deleted.txt', '.env', 'nested/.git/config']) {
    await assert.rejects(service.git('diff', undefined, { path }), /Invalid workspace path/);
  }
});

test('workspace tool advertises owned actions and Jev chooses a validated read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'hello workspace\n');
  const seen: RouteRequest[] = [];
  const workspace = new WorkspaceService(root, selecting('read_file', seen));
  const config = loadConfig({ FUSION_MCP_PROFILE: 'full' });
  const server = createFusionMcpServer({ router: selecting('read_file', seen), config, workspace });
  const client = new Client({ name: 'workspace-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const advertised = (await client.listTools()).tools;
  assert.deepEqual(
    advertised.map((tool) => tool.name),
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
  assert.equal(new Set(advertised.map((tool) => tool.title)).size, advertised.length);
  const result = await client.callTool({
    name: 'fusion_workspace',
    arguments: { task: 'Read the README', path: 'README.md' },
  });
  assert.equal((result.structuredContent as any).route.decision.source, 'jev');
  assert.deepEqual((result.structuredContent as any).execution, {
    status: 'executed',
    output: { path: 'README.md', content: 'hello workspace\n', truncated: false },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(
    seen[0]!.candidates?.map((candidate) => candidate.tool),
    ['read_file'],
  );
});

test('named reads skip inference and page output without losing line numbers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.txt'), 'one\ntwo\nthree\nfour\n');
  const seen: RouteRequest[] = [];
  const router = selecting('read_file', seen);
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
  });
  const client = new Client({ name: 'named-tools-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: 'fusion_read_file',
    arguments: { path: 'notes.txt', startLine: 2, maxLines: 2, format: 'structured' },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual((result.structuredContent as any).lines, [
    { number: 2, text: 'two' },
    { number: 3, text: 'three' },
  ]);
  assert.equal((result.structuredContent as any).nextLine, 4);
  assert.equal(seen.length, 0);
});

test('repository overview gathers bounded entrypoint evidence in one MCP call without Jev or secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-overview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'src', 'providers'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), '# Example project\nThis is the purpose.\n');
  await writeFile(
    join(root, 'docs', 'design.md'),
    Array.from({ length: 70 }, (_, i) => `Design note ${i + 1}`).join('\n'),
  );
  await writeFile(join(root, 'package.json'), '{"main":"src/index.ts"}\n');
  await writeFile(join(root, 'src', 'index.ts'), 'export const ready = true;\n');
  await writeFile(
    join(root, 'src', 'router.ts'),
    `export class ExampleRouter {\n${Array.from({ length: 10 }, (_, i) => `  async route${i}() { return true; }`).join('\n')}\n}\n`,
  );
  await writeFile(join(root, 'src', 'providers', 'jev.ts'), 'export class ExampleProvider {}\n');
  await writeFile(join(root, '.env'), 'SECRET_SHOULD_NOT_APPEAR=1\n');
  const seen: RouteRequest[] = [];
  const router = selecting('unknown', seen);
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
  });
  const client = new Client({ name: 'overview-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: 'fusion_repo_overview', arguments: { detail: 'deep', maxChars: 4000 } });
  const content = (result.content as any)[0].text as string;
  assert.match(content, /Example project/);
  assert.match(content, /src\/index\.ts/);
  assert.match(content, /ready = true/);
  assert.match(content, /src\/router\.ts/);
  assert.match(content, /ExampleRouter/);
  assert.match(content, /src\/providers\/jev\.ts/);
  assert.match(content, /docs\/design\.md/);
  assert.match(content, /Selective map/);
  assert.ok(!content.includes('SECRET_SHOULD_NOT_APPEAR'));
  assert.ok(content.length <= 4000);
  assert.equal((result.structuredContent as any).modelCalls, 0);
  assert.ok((result.structuredContent as any).clipped.every((label: string) => label.startsWith('File ')));
  const coverage = (result.structuredContent as any).coverage;
  assert.equal(coverage.kind, 'selective-map');
  assert.equal(coverage.sourceFilesDiscovered, 3);
  const routerCoverage = coverage.sourceOutlines.find((item: any) => item.path === 'src/router.ts');
  assert.ok(
    routerCoverage.symbolsFound > routerCoverage.symbolsShown,
    'omitted symbols are reported independently of output clipping',
  );
  assert.ok(routerCoverage.codeWindows.length > 0);
  assert.ok(coverage.documentExcerpts.some((item: any) => item.path === 'docs/design.md' && item.continues));
  const roomy = await client.callTool({ name: 'fusion_repo_overview', arguments: { detail: 'deep', maxChars: 8000 } });
  assert.deepEqual((roomy.structuredContent as any).clipped, []);
  assert.match((roomy.content as any)[0].text, /Representative code windows/);
  assert.match((roomy.content as any)[0].text, /return true/);
  assert.equal(seen.length, 0);
  const controller = new AbortController();
  const interruptedService = new WorkspaceService(root, router);
  t.mock.method(interruptedService, 'read', async (path: string) => {
    controller.abort();
    return {
      path,
      startLine: 1,
      lines: [{ number: 1, text: 'partial evidence' }],
      nextLine: null,
      shortenedLines: false,
    };
  });
  const interruptedServer = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: interruptedService,
    signal: controller.signal,
  });
  const interruptedClient = new Client({ name: 'overview-cancel-test', version: '1' });
  const [cancelLeft, cancelRight] = InMemoryTransport.createLinkedPair();
  await interruptedServer.connect(cancelLeft);
  await interruptedClient.connect(cancelRight);
  t.after(async () => {
    await interruptedClient.close();
    await interruptedServer.close();
  });
  const cancelled = await interruptedClient.callTool({ name: 'fusion_repo_overview', arguments: {} });
  assert.equal(cancelled.isError, true);
  assert.equal((cancelled.structuredContent as any).error.code, 'CANCELLED');
});

test('oversized MCP result requests are capped and paginated without failing the inspection batch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 60 }, (_, i) => writeFile(join(root, `file-${String(i).padStart(2, '0')}.txt`), 'needle\n')),
  );
  const seen: RouteRequest[] = [];
  const router = selecting('unknown', seen);
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
  });
  const client = new Client({ name: 'limit-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const direct = await client.callTool({ name: 'fusion_list_files', arguments: { maxResults: 500 } });
  assert.equal(direct.isError, undefined);
  assert.match((direct.content as any)[0].text, /LIMIT APPLIED: maxResults=50/);
  assert.match((direct.content as any)[0].text, /nextOffset=50/);
  const batch = await client.callTool({
    name: 'fusion_inspect',
    arguments: {
      requests: [
        { action: 'list', maxResults: 500 },
        { action: 'search', query: 'needle', maxResults: 1000 },
      ],
    },
  });
  assert.equal(batch.isError, undefined);
  assert.deepEqual((batch.structuredContent as any).failed, []);
  assert.equal(((batch.content as any)[0].text as string).match(/LIMIT APPLIED/g)?.length, 2);
  assert.match((batch.content as any)[0].text, /nextOffset=50/);
  assert.equal(seen.length, 0);
});

test('standard overview retains module edges and symbols, scans each source once, and leaves deep excerpts opt-in', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-standard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), '# Example\nA routing example.');
  const fixtures = {
    'src/index.ts': 'export { Router } from "./router.js";\n',
    'src/router.ts':
      'import type { Request } from "./types.js";\nexport class Router {\n  async route(request: Request) {\n    return request;\n  }\n}\n' +
      '\n'.repeat(350),
    'src/types.ts': 'export interface Request { task: string }\n',
  };
  await Promise.all(Object.entries(fixtures).map(([path, text]) => writeFile(join(root, path), text)));
  const router = selecting('unknown', []);
  const workspace = new WorkspaceService(root, router);
  const read = t.mock.method(workspace, 'read');
  const scan = t.mock.method(workspace, 'readOverview');
  const server = createFusionMcpServer({ router, config: loadConfig({}), workspace });
  const client = new Client({ name: 'standard-map-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const standard = await client.callTool({ name: 'fusion_repo_overview', arguments: {} });
  const text = (standard.content as any)[0].text as string;
  const metadata = standard.structuredContent as any;
  assert.equal(metadata.detail, 'standard');
  assert.deepEqual(metadata.clipped, []);
  assert.equal(metadata.coverage.sourceFilesOutlined, 3);
  assert.equal(metadata.coverage.dependencyEdges, 2);
  assert.equal(metadata.coverage.unresolvedLocalImports, 0);
  assert.equal(metadata.modelCalls, 0);
  assert.match(text, /src\/index.ts -> src\/router.ts:1 \(re-export\)/);
  assert.match(text, /src\/router.ts -> src\/types.ts:1 \(type\)/);
  assert.match(text, /Router:2, route:3/);
  assert.doesNotMatch(text, /code windows|return request/);
  assert.equal(scan.mock.callCount(), 3, 'each source is scanned once, including files over 300 lines');
  assert.equal(read.mock.callCount(), 1, 'only the README uses the paginated reader');
  const deep = await client.callTool({ name: 'fusion_repo_overview', arguments: { detail: 'deep' } });
  assert.match((deep.content as any)[0].text, /return request/);
  assert.equal((deep.structuredContent as any).coverage.dependencyEdges, metadata.coverage.dependencyEdges);
  assert.ok(JSON.stringify(standard).length < JSON.stringify(deep).length);
});

test('separate MCP calls can execute concurrently on one connection', { timeout: 3000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-parallel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const router = selecting('unknown', []);
  const workspace = new WorkspaceService(root, router);
  const started = deferred();
  const release = deferred();
  let active = 0;
  t.mock.method(workspace, 'read', async (path: string) => {
    if (++active === 2) started.resolve();
    await release.promise;
    return { path, startLine: 1, lines: [{ number: 1, text: path }], nextLine: null, shortenedLines: false };
  });
  const server = createFusionMcpServer({ router, config: loadConfig({}), workspace });
  const client = new Client({ name: 'parallel-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    release.resolve();
    await client.close();
    await server.close();
  });
  const calls = ['one.txt', 'two.txt'].map((path) =>
    client.callTool({ name: 'fusion_read_file', arguments: { path } }),
  );
  await started.promise;
  release.resolve();
  const results = await Promise.all(calls);
  assert.ok(results.every((result) => !result.isError));
  assert.match((results[0]!.content as any)[0].text, /one.txt/);
  assert.match((results[1]!.content as any)[0].text, /two.txt/);
});

test('named tools return stable errors and use the requested workspace root', async (t) => {
  const first = await mkdtemp(join(tmpdir(), 'fusion-first-'));
  const second = await mkdtemp(join(tmpdir(), 'fusion-second-'));
  t.after(async () => {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });
  await writeFile(join(first, 'one.txt'), 'first');
  await writeFile(join(second, 'two.txt'), 'second');
  const router = selecting('unknown', []);
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspaceFactory: (root) => new WorkspaceService(root ?? first, router),
  });
  const client = new Client({ name: 'roots-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const listed = await client.callTool({
    name: 'fusion_list_files',
    arguments: { root: second, format: 'structured' },
  });
  assert.deepEqual(
    (listed.structuredContent as any).entries.map((entry: any) => entry.name),
    ['two.txt'],
  );
  const badRoot = await client.callTool({ name: 'fusion_list_files', arguments: { root: 'relative/path' } });
  assert.equal((badRoot.structuredContent as any).error.code, 'INVALID_PATH');
  const denied = await client.callTool({ name: 'fusion_read_file', arguments: { root: second, path: '../one.txt' } });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as any).error.code, 'INVALID_PATH');
  const missing = await client.callTool({ name: 'fusion_read_file', arguments: { root: second, path: 'missing.txt' } });
  assert.equal((missing.structuredContent as any).error.code, 'NOT_FOUND');
  const git = await client.callTool({ name: 'fusion_git_status', arguments: { root: second } });
  assert.equal((git.structuredContent as any).error.code, 'GIT_FAILED');
});

test('named listing pages and cancellation stops direct file reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => writeFile(join(root, name), name)));
  const service = new WorkspaceService(root, selecting('unknown', []));
  const first = await service.list('.', 2);
  assert.deepEqual(
    first.entries.map((entry) => entry.name),
    ['a.txt', 'b.txt'],
  );
  assert.equal(first.nextOffset, 2);
  const second = await service.list('.', 2, first.nextOffset!);
  assert.deepEqual(
    second.entries.map((entry) => entry.name),
    ['c.txt'],
  );
  assert.equal(second.nextOffset, null);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(service.read('a.txt', 1, 10, abort.signal), (error: any) => error.code === 'CANCELLED');
  const timedOut = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
  await assert.rejects(service.read('a.txt', 1, 10, timedOut), (error: any) => error.code === 'TIMEOUT');
});

test('direct reads reject binary and oversized files with actionable codes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  const large = await open(join(root, 'large.txt'), 'w');
  try {
    await large.truncate(8 * 1024 * 1024 + 1);
  } finally {
    await large.close();
  }
  const service = new WorkspaceService(root, selecting('unknown', []));
  await assert.rejects(service.read('binary.bin'), (error: any) => error.code === 'NOT_TEXT_FILE');
  // Oversize files stream instead of failing with FILE_TOO_LARGE; this sparse file is NUL bytes, so it is rejected as non-text.
  await assert.rejects(service.read('large.txt'), (error: any) => error.code === 'NOT_TEXT_FILE');
  await assert.rejects(service.snapshot('large.txt'), (error: any) => error.code === 'FILE_TOO_LARGE');
});

test('large Git diff returns a bounded partial result instead of a buffer error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const file = join(root, 'large.txt');
  await writeFile(file, 'old\n');
  assert.equal(spawnSync('git', ['-C', root, 'add', 'large.txt']).status, 0);
  await writeFile(
    file,
    Array.from({ length: 3000 }, (_, i) => `new line ${i} with enough text to exceed the limit`).join('\n'),
  );
  const output = await new WorkspaceService(root, selecting('unknown', [])).git('diff');
  assert.equal(output.truncated, true);
  assert.ok(output.text.length > 0 && Buffer.byteLength(output.text) <= 32 * 1024);
  const log = await new WorkspaceService(root, selecting('unknown', [])).git('log');
  assert.equal(log.text, '');
});

test('Git status, diff and log stay inside a nested workspace root', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'fusion-git-root-'));
  const root = join(repository, 'allowed');
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(root);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  await writeFile(join(repository, 'outside.txt'), 'before outside\n');
  assert.equal(git('add', 'outside.txt').status, 0);
  assert.equal(
    git('-c', 'user.name=Fusion Test', '-c', 'user.email=fusion@example.test', 'commit', '-qm', 'outside baseline')
      .status,
    0,
  );
  await writeFile(join(root, 'inside.txt'), 'before inside\n');
  assert.equal(git('add', 'allowed/inside.txt').status, 0);
  assert.equal(
    git('-c', 'user.name=Fusion Test', '-c', 'user.email=fusion@example.test', 'commit', '-qm', 'inside baseline')
      .status,
    0,
  );
  await writeFile(join(repository, 'outside.txt'), 'after outside\n');
  await writeFile(join(root, 'inside.txt'), 'after inside\n');
  await writeFile(join(repository, 'outside-untracked.txt'), 'outside\n');
  await writeFile(join(root, 'inside-untracked.txt'), 'inside\n');

  const service = new WorkspaceService(root, selecting('unknown', []));
  const status = await service.git('status');
  assert.match(status.text, /inside\.txt/);
  assert.doesNotMatch(status.text, /outside\.txt/);
  const diff = await service.git('diff');
  assert.match(diff.text, /inside\.txt/);
  assert.doesNotMatch(diff.text, /outside\.txt/);
  const log = await service.git('log');
  assert.match(log.text, /inside baseline/);
  assert.doesNotMatch(log.text, /outside baseline/);
});

test('workspace search and listing stay inside the root and return bounded results', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'one.ts'), 'alpha\nneedle here\n');
  await writeFile(join(root, 'src', 'two.ts'), 'needle again\n');
  await writeFile(join(root, 'src', '.env.local'), 'needle=secret\n');
  const seen: RouteRequest[] = [];
  const search = new WorkspaceService(root, selecting('search_text', seen));
  const found = await search.run({ task: 'Find needle', path: 'src', query: 'needle', maxResults: 1 });
  assert.equal(found.execution?.status, 'executed');
  assert.equal((found.execution as any).output.matches.length, 1);
  assert.deepEqual(
    seen[0]!.candidates?.map((candidate) => candidate.tool),
    ['list_files', 'search_text'],
  );
  const list = new WorkspaceService(root, selecting('list_files', []));
  const listed = await list.run({ task: 'Show files', path: 'src' });
  assert.deepEqual(
    (listed.execution as any).output.entries.map((entry: any) => entry.name),
    ['one.ts', 'two.ts'],
  );
  await assert.rejects(search.run({ task: 'Escape', path: '../outside', query: 'x' }), /workspace path/i);
  await assert.rejects(search.run({ task: 'Read secret', path: 'src/.env.local' }), /workspace path/i);
});

test('host escalation never executes a workspace action', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'keep local');
  const result = await new WorkspaceService(root, selecting('unknown', [])).run({
    task: 'Read note',
    path: 'note.txt',
  });
  assert.equal(result.route.decision.status, 'escalate');
  assert.equal(result.execution, undefined);
});

test('a selected call outside the server-owned candidate set never executes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'keep local');
  const router: RoutingService = {
    async route() {
      return {
        decision: {
          status: 'selected',
          source: 'jev',
          candidateId: 'forged',
          call: { tool: 'read_file', arguments: { path: 'note.txt' } },
        },
        usage: [],
        latencyMs: 1,
      };
    },
    async routeBatch() {
      throw new Error('not used');
    },
  };
  const result = await new WorkspaceService(root, router).run({ task: 'Read note', path: 'note.txt' });
  assert.deepEqual(result.execution, { status: 'invalid' });
});

test('Jev can choose a fixed read-only git command without accepting shell text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  await writeFile(join(root, 'note.txt'), 'hello');
  const seen: RouteRequest[] = [];
  const workspace = new WorkspaceService(root, selecting('git_status', seen));
  const result = await workspace.run({ task: 'Show git status' });
  assert.equal(result.execution?.status, 'executed');
  assert.match((result.execution as any).output.text, /note\.txt/);
  assert.deepEqual(
    seen[0]!.candidates?.map((candidate) => candidate.tool),
    ['list_files', 'git_status', 'git_diff', 'git_log'],
  );
  assert.ok(seen[0]!.tools.every((tool) => tool.readOnly === true));
});

test('search pages within a single file, includes context and matches beyond old clipping boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'source.txt'),
    ['before', 'needle first', 'between', 'x'.repeat(600) + 'other needle', 'after'].join('\n'),
  );
  const service = new WorkspaceService(root, selecting('unknown', []));
  const first = await service.search(['needle', 'other'], '.', 1, undefined, { contextLines: 1 });
  assert.equal(first.nextOffset, 1);
  assert.equal(first.truncated, true);
  assert.deepEqual(
    first.matches[0]!.context?.map((l) => l.line),
    [1, 2, 3],
  );
  const next = await service.search(['needle', 'other'], '.', 1, undefined, { offset: first.nextOffset! });
  assert.equal(next.nextOffset, null);
  assert.equal(next.truncated, false);
  assert.equal(next.matches.length, 1, 'OR queries do not duplicate a matching line');
  assert.match(next.matches[0]!.text, /other needle/);
  assert.equal(next.matches[0]!.shortened, true);
  await assert.rejects(service.search([], '.'), (e: any) => e.code === 'INVALID_REQUEST');
  await assert.rejects(service.search('x', '.', 10, AbortSignal.abort()), (e: any) => e.code === 'CANCELLED');
});

test('search reports skipped content and reading rejects invalid UTF-8 past the first chunk', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-invalid-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'invalid.txt'), Buffer.concat([Buffer.from('a'.repeat(20000)), Buffer.from([0xff])]));
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  await writeFile(join(root, 'oversize.txt'), 'needle'.repeat(50000));
  const service = new WorkspaceService(root, selecting('unknown', []));
  await assert.rejects(service.read('invalid.txt'), (e: any) => e.code === 'NOT_TEXT_FILE');
  const result = await service.search('needle');
  // The 300 KB file is over the per-file limit but is now scanned within the byte budget instead of skipped.
  assert.deepEqual(
    result.matches.map((match) => match.path),
    ['oversize.txt'],
  );
  assert.equal(result.skippedFiles, 2);
  assert.equal(result.truncated, true);
});

test('compact MCP and inspection preserve evidence once, order, failures and request deduplication', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.txt'), 'unique evidence\nneedle\nnext\n');
  const seen: RouteRequest[] = [];
  const router = selecting('unknown', seen);
  const service = new WorkspaceService(root, router);
  let reads = 0;
  const original = service.read.bind(service);
  t.mock.method(service, 'read', async (...args: Parameters<typeof service.read>) => {
    reads++;
    return original(...args);
  });
  const server = createFusionMcpServer({ router, config: loadConfig({}), workspace: service });
  const client = new Client({ name: 'inspect-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const direct = await client.callTool({ name: 'fusion_read_file', arguments: { path: 'source.txt', maxLines: 1 } });
  assert.equal(direct.structuredContent, undefined);
  assert.match((direct.content as any)[0].text, /nextLine=2/);
  assert.equal(JSON.stringify(direct).split('unique evidence').length - 1, 1);
  reads = 0;
  const result = await client.callTool({
    name: 'fusion_inspect',
    arguments: {
      requests: [
        { action: 'read', path: 'source.txt' },
        { path: 'source.txt', action: 'read' },
        { action: 'read', path: 'missing.txt' },
        { action: 'search', query: ['needle', 'next'], contextLines: 1 },
      ],
    },
  });
  const text = (result.content as any)[0].text as string;
  const { evidenceRefs, ...legacyMetadata } = result.structuredContent as any;
  assert.deepEqual(legacyMetadata, { requests: 4, failed: [3], clipped: [], executed: 3, modelCalls: 0 });
  assert.deepEqual(
    evidenceRefs.map((item: any) => item.request),
    [1, 4],
  );
  assert.ok(
    text.indexOf('[1 read]') < text.indexOf('[2 read]') && text.indexOf('[2 read]') < text.indexOf('[3 read ERROR]'),
  );
  assert.match(text, /Same as request 1/);
  assert.match(text, /NOT_FOUND/);
  assert.equal(text.split('"source.txt":2: needle').length - 1, 1, 'overlapping context is emitted once');
  assert.equal(reads, 2, 'one successful read plus one missing path; no duplicate execution');
  assert.equal(seen.length, 0);
  const invalid = await client.callTool({
    name: 'fusion_inspect',
    arguments: { requests: [{ action: 'shell', command: 'echo hi' }] },
  });
  assert.equal(invalid.isError, true);
});

test('snapshot reads complete allowed bytes and rejects secrets and oversized files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = '🔬'.repeat(20_000);
  await writeFile(join(root, 'long.txt'), source);
  await writeFile(join(root, '.env'), 'secret');
  await writeFile(join(root, 'huge.txt'), Buffer.alloc(8 * 1024 * 1024 + 1));
  const service = new WorkspaceService(root, selecting('unknown', []));
  const snapshot = await service.snapshot('long.txt');
  assert.equal(snapshot.path, 'long.txt');
  assert.equal(snapshot.originalBytes, Buffer.byteLength(source));
  assert.deepEqual(snapshot.bytes, Buffer.from(source));
  await assert.rejects(service.snapshot('.env'), (error: any) => error.code === 'INVALID_PATH');
  await assert.rejects(service.snapshot('huge.txt'), (error: any) => error.code === 'FILE_TOO_LARGE');
});

test('snapshot rejects a path redirected outside the root after resolution', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-snapshot-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'root');
  const outside = join(directory, 'outside');
  const entry = join(root, 'entry');
  await mkdir(entry, { recursive: true });
  await mkdir(outside);
  await writeFile(join(entry, 'note.txt'), 'allowed');
  await writeFile(join(outside, 'note.txt'), 'private outside');
  const service = new WorkspaceService(root, selecting('unknown', []));
  t.mock.method(service as any, 'resolvePath', async () => {
    await rm(entry, { recursive: true });
    await symlink(outside, entry, process.platform === 'win32' ? 'junction' : 'dir');
    return join(entry, 'note.txt');
  });
  await assert.rejects(service.snapshot('entry/note.txt'), (error: any) => error.code === 'INVALID_PATH');
});

test('inspection receipt follows the bytes used for the visible read when source changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-inspect-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'version A\n');
  const router = selecting('unknown', []);
  const service = new WorkspaceService(root, router);
  const originalRead = service.read.bind(service);
  t.mock.method(service, 'read', async (...args: Parameters<typeof service.read>) => {
    const result = await originalRead(...args);
    await writeFile(join(root, 'note.txt'), 'version B\n');
    return result;
  });
  const evidence = new EvidenceStore();
  const server = createFusionMcpServer({ router, config: loadConfig({}), workspace: service, evidence });
  const client = new Client({ name: 'version-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: 'fusion_inspect',
    arguments: { requests: [{ action: 'read', path: 'note.txt' }] },
  });
  assert.match((result.content as any)[0].text, /version A/);
  const ref = (result.structuredContent as any).evidenceRefs[0];
  assert.ok(ref.receipt);
  const page = await evidence.expand({ id: ref.receipt.id });
  assert.equal(page.status, 'stale');
  if (page.status === 'stale') assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), 'version A\n');
});

test('Git receipt preserves raw capped stdout bytes and unknown original length', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-git-raw-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(git('init', '-q').status, 0);
  await writeFile(join(root, 'note.txt'), 'before\n');
  assert.equal(git('add', 'note.txt').status, 0);
  assert.equal(
    git('-c', 'user.name=Fusion Test', '-c', 'user.email=fusion@example.test', 'commit', '-qm', 'baseline').status,
    0,
  );
  await writeFile(join(root, 'note.txt'), 'a'.repeat(32700) + '😀'.repeat(100) + '\n');
  const diff = () => git('--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--', '.').stdout as Buffer;
  const firstEmoji = diff().indexOf(Buffer.from('😀'));
  const padding = 32700 + 32766 - firstEmoji;
  assert.ok(padding > 0);
  await writeFile(join(root, 'note.txt'), 'a'.repeat(padding) + '😀'.repeat(100) + '\n');
  const expected = diff();
  assert.equal(expected[32766], 0xf0);
  assert.equal(expected[32767], 0x9f);
  const router = selecting('unknown', []);
  const evidence = new EvidenceStore();
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
    evidence,
  });
  const client = new Client({ name: 'git-raw-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: 'fusion_inspect', arguments: { requests: [{ action: 'git_diff' }] } });
  const receipt = (result.structuredContent as any).evidenceRefs[0].receipt;
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.originalBytes, null);
  const page = await evidence.expand({ id: receipt.id, maxBytes: 64 * 1024 });
  assert.equal(page.status, 'ok');
  if (page.status === 'ok') assert.deepEqual(Buffer.from(page.dataBase64, 'base64'), expected.subarray(0, 32768));
});

test('inspection receipts expand full read and search sources despite compact clipping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-inspect-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = 'needle ' + '漢'.repeat(12_000) + '\n';
  await writeFile(join(root, 'long.txt'), source);
  const router = selecting('unknown', []);
  const evidence = new EvidenceStore();
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
    evidence,
  });
  const client = new Client({ name: 'inspect-evidence-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: 'fusion_inspect',
    arguments: {
      requests: [
        { action: 'read', path: 'long.txt' },
        { action: 'search', path: 'long.txt', query: 'needle' },
      ],
      maxChars: 2000,
    },
  });
  const metadata = result.structuredContent as any;
  assert.equal(metadata.evidenceRefs.length, 2);
  for (const ref of metadata.evidenceRefs) {
    const page = await evidence.expand({ id: ref.receipt.id, maxBytes: 64 * 1024 });
    assert.equal(page.status, 'ok');
    if (page.status === 'ok') assert.deepEqual(Buffer.from(page.dataBase64, 'base64'), Buffer.from(source));
  }
  assert.ok(metadata.clipped.length > 0);
});

test('inspection labels unavailable snapshots without hiding the compact read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-inspect-unavailable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'visible line\n');
  const router = selecting('unknown', []);
  const service = new WorkspaceService(root, router);
  t.mock.method(service, 'sourceCaptures', () => []);
  const server = createFusionMcpServer({ router, config: loadConfig({}), workspace: service });
  const client = new Client({ name: 'unavailable-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: 'fusion_inspect',
    arguments: { requests: [{ action: 'read', path: 'note.txt' }] },
  });
  assert.match((result.content as any)[0].text, /visible line/);
  assert.deepEqual((result.structuredContent as any).evidenceRefs, [
    { request: 1, path: 'note.txt', status: 'unavailable' },
  ]);
});

test('inspection preserves a listing if evidence storage fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-inspect-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'visible');
  const router = selecting('unknown', []);
  class FailingStore extends EvidenceStore {
    override capture(): never {
      throw new Error('storage unavailable');
    }
  }
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
    evidence: new FailingStore(),
  });
  const client = new Client({ name: 'storage-failure-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: 'fusion_inspect', arguments: { requests: [{ action: 'list' }] } });
  assert.match((result.content as any)[0].text, /note\.txt/);
  assert.deepEqual((result.structuredContent as any).failed, []);
  assert.deepEqual((result.structuredContent as any).evidenceRefs, [{ request: 1, path: '.', status: 'unavailable' }]);
});

test('inspection bounds concurrency and output, and marks queued work cancelled without executing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-bounded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const router = selecting('unknown', []);
  const service = new WorkspaceService(root, router);
  let running = 0,
    peak = 0,
    started = 0;
  const controller = new AbortController();
  t.mock.method(service, 'read', async (path: string) => {
    started++;
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    return {
      path,
      startLine: 1,
      lines: [{ number: 1, text: 'e'.repeat(3000) }],
      nextLine: null,
      shortenedLines: false,
    };
  });
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: service,
    signal: controller.signal,
  });
  const client = new Client({ name: 'bounded-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const requests = Array.from({ length: 8 }, (_, i) => ({ action: 'read', path: `${i}.txt` }));
  const result = await client.callTool({ name: 'fusion_inspect', arguments: { requests, maxChars: 2000 } });
  assert.equal(peak, 4);
  assert.equal(started, 8);
  assert.equal((result.structuredContent as any).clipped.length, 8);
  assert.ok((result.content as any)[0].text.length <= 2000);
  controller.abort();
  const cancelled = await client.callTool({ name: 'fusion_inspect', arguments: { requests } });
  assert.equal(started, 8, 'aborted work is never started');
  assert.equal((cancelled.structuredContent as any).executed, 0);
  assert.deepEqual((cancelled.structuredContent as any).failed, [1, 2, 3, 4, 5, 6, 7, 8]);
});
