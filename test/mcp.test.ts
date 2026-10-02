import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { loadConfig } from '../src/config.js';
import { FusionRouter } from '../src/router.js';
import { createFusionMcpServer, startHttpServer, type RoutingService } from '../src/mcp.js';
import { WorkspaceService } from '../src/workspace.js';
import { ESCALATE, type RouteRequest } from '../src/types.js';

const tool = { name: 'lookup', description: 'Lookup a known item', readOnly: true, inputSchema: { type: 'object', properties: { id: { enum: ['a'] } }, required: ['id'], additionalProperties: false } };
const router: RoutingService = {
  async route(request: RouteRequest) { return { decision: { status: 'selected', source: 'jev', call: { tool: request.tools[0]!.name, arguments: { id: 'a' } }, candidateId: 'a', requiresApproval: false }, usage: [], latencyMs: 1 }; },
  async routeBatch(requests: RouteRequest[]) { return { decisions: (await Promise.all(requests.map(r => this.route(r)))).map(r => r.decision), usage: [], latencyMs: 1 }; },
};

test('MCP catalog supplies omitted schemas and rejects catalog overrides and oversized batches', async t => {
  const config = loadConfig({}); config.catalog = [tool]; config.routing.maxBatchSize = 1;
  const server = createFusionMcpServer({ router, config });
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 4);
  assert.deepEqual(listed.tools.map(tool => tool.name), ['fusion_choose', 'fusion_choose_batch', 'fusion_route', 'fusion_route_batch']);
  const rawList = await client.request({ method: 'tools/list' }, z.object({ tools: z.array(z.looseObject({ name: z.string() })) }));
  assert.deepEqual(rawList.tools[0]?.securitySchemes, [{ type: 'noauth' }]);
  const result = await client.callTool({ name: 'fusion_route', arguments: { task: 'Look up a' } });
  assert.equal((result.structuredContent as any).decision.call.tool, 'lookup');
  const choice = await client.callTool({ name: 'fusion_choose', arguments: { task: 'Pick the best option', options: [
    { id: 'a', description: 'Use a targeted read' }, { id: 'b', description: 'Use a broader scan' }] } });
  assert.equal((choice.structuredContent as any).choiceId, 'a');
  assert.equal((choice.structuredContent as any).status, 'selected');
  const choiceBatch = await client.callTool({ name: 'fusion_choose_batch', arguments: { requests: [{ task: 'Pick', options: [
    { id: 'a', description: 'A' }, { id: 'b', description: 'B' }] }] } });
  assert.equal((choiceBatch.structuredContent as any).choices[0].choiceId, 'a');
  const duplicate = await client.callTool({ name: 'fusion_choose', arguments: { task: 'Pick', options: [
    { id: 'a', description: 'A' }, { id: 'a', description: 'B' }] } });
  assert.equal(duplicate.isError, true);
  const overridden = await client.callTool({ name: 'fusion_route', arguments: { task: 'Look up a', tools: [{ ...tool, readOnly: false }] } });
  assert.equal(overridden.isError, true);
  const oversized = await client.callTool({ name: 'fusion_route_batch', arguments: { requests: [{ task: 'a' }, { task: 'b' }] } });
  assert.equal(oversized.isError, true);
  const unknown = await client.callTool({ name: 'fusion_route', arguments: { task: 'a', toolNames: ['missing'] } });
  assert.equal(unknown.isError, true);
});

test('workspace assist advertises three concise tools and full retains legacy schemas', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inspect = async (profile: 'assist' | 'full') => {
    const config = loadConfig({ FUSION_MCP_PROFILE: profile });
    const server = createFusionMcpServer({ router, config, workspace: new WorkspaceService(root, router) });
    const client = new Client({ name: `profile-${profile}`, version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left); await client.connect(right);
    t.after(async () => { await client.close(); await server.close(); });
    return { tools: (await client.listTools()).tools, instructions: client.getInstructions() };
  };
  const assist = await inspect('assist');
  const full = await inspect('full');
  assert.deepEqual(assist.tools.map(tool => tool.name), ['fusion_assist', 'fusion_inspect', 'fusion_evidence']);
  assert.ok(assist.tools.reduce((size, tool) => size + (tool.description?.length ?? 0), 0) < 360);
  assert.deepEqual(full.tools.map(tool => tool.name), ['fusion_repo_overview', 'fusion_inspect', 'fusion_list_files',
    'fusion_read_file', 'fusion_search_text', 'fusion_git_status', 'fusion_git_diff', 'fusion_git_log',
    'fusion_workspace', 'fusion_choose', 'fusion_choose_batch', 'fusion_route', 'fusion_route_batch',
    'fusion_assist', 'fusion_evidence']);
  const legacy = full.tools.find(tool => tool.name === 'fusion_read_file');
  assert.ok(legacy?.inputSchema.properties?.path);
  assert.ok(legacy?.inputSchema.properties?.startLine);
  assert.ok(legacy?.inputSchema.properties?.maxLines);
  assert.match(assist.instructions ?? '', /Fusion.*inspection/i);
  assert.match(assist.instructions ?? '', /RTK/);
  assert.match(assist.instructions ?? '', /npx -y fusion-jev@\d+\.\d+\.\d+ run/);
  assert.ok((assist.instructions ?? '').length < 700);
});

test('fusion_assist is workspace-gated and refuses a different fixed root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-assist-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  await mkdir(root);
  await writeFile(join(root, 'note.txt'), 'inside\n');
  const config = loadConfig({});
  const service = new WorkspaceService(root, router);
  const server = createFusionMcpServer({ router, config, workspace: service });
  const client = new Client({ name: 'assist-mcp-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'fusion_assist'));
  const allowed = await client.callTool({ name: 'fusion_assist', arguments: { task: 'Read note.txt' } });
  assert.equal((allowed.structuredContent as any).status, 'evidence');
  assert.equal((allowed.structuredContent as any).telemetry.hostVisibleBytes,
    Buffer.byteLength(JSON.stringify({ content: allowed.content, structuredContent: allowed.structuredContent })));
  const denied = await client.callTool({ name: 'fusion_assist', arguments: { task: 'Read note.txt', root: directory } });
  assert.equal(denied.isError, true);
});

test('paginated fusion_inspect list has workspace provenance and exact recoverable page bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-inspect-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'alpha.txt'), 'alpha');
  await writeFile(join(root, 'beta.txt'), 'beta');
  const server = createFusionMcpServer({ router, config: loadConfig({}), workspace: new WorkspaceService(root, router) });
  const client = new Client({ name: 'inspect-list-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const inspect = await client.callTool({ name: 'fusion_inspect', arguments: { requests: [{ action: 'list', path: '.', maxResults: 1 }] } });
  assert.equal(inspect.isError, undefined);
  const content = (inspect.content as Array<{ text: string }>)[0]!.text;
  const receipt = (inspect.structuredContent as any).evidenceRefs[0].receipt;
  assert.deepEqual(receipt.source, { kind: 'derived_workspace', root, path: '.', operation: 'list' });
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.originalBytes, null);
  const expanded = await client.callTool({ name: 'fusion_evidence', arguments: { action: 'get', id: receipt.id } });
  assert.equal(expanded.isError, undefined);
  const page = expanded.structuredContent as any;
  assert.equal(page.status, 'ok');
  assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), content.replace(/^\[1 list\]\n/, ''));
});

test('HTTP assist shares process-local evidence and continuations across sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-assist-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'many.txt'), Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'));
  const config = loadConfig({ FUSION_HTTP_BEARER_TOKEN: 'assist-token' }); config.http.port = 0;
  const server = await startHttpServer({ router, config, workspace: new WorkspaceService(root, router) });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const connect = async () => {
    const client = new Client({ name: 'assist-session', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer assist-token' } } }));
    t.after(() => client.close());
    return client;
  };
  const first = await connect();
  const second = await connect();
  const page = (await first.callTool({ name: 'fusion_assist', arguments: { task: 'Read many.txt' } })).structuredContent as any;
  assert.equal(page.status, 'continue');
  assert.ok(page.evidenceIds[0]);
  const next = (await second.callTool({ name: 'fusion_assist', arguments: { task: 'Read many.txt', continuation: page.continuation } })).structuredContent as any;
  assert.equal(next.actions.length, 2);
  const imported = (await second.callTool({ name: 'fusion_assist', arguments: { task: 'Review output', evidenceIds: [page.evidenceIds[0]] } })).structuredContent as any;
  assert.equal(imported.status, 'evidence');
});

test('MCP choice reaches the real router without optional context and batches one provider call', async t => {
  const config = loadConfig({});
  let calls = 0;
  const realRouter = new FusionRouter({ config, jev: { async choose(requests) {
    calls++;
    return { answers: requests.map(request => {
      assert.equal(request.strategy, 'jev-only');
      assert.equal(request.context, undefined);
      assert.deepEqual(request.candidates.map(candidate => candidate.id), ['read', 'search']);
      return { choice: 'read', confidence: 0.99, probabilities: { read: 0.98, search: 0.01, [ESCALATE]: 0.01 } };
    }), usage: [] };
  } } });
  const server = createFusionMcpServer({ router: realRouter, config });
  const client = new Client({ name: 'choice-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  t.after(async () => { await client.close(); await server.close(); });
  const input = { task: 'Read a known file', options: [{ id: 'read', description: 'Read the known file' },
    { id: 'search', description: 'Search all files' }] };
  const single = await client.callTool({ name: 'fusion_choose', arguments: input });
  assert.equal((single.structuredContent as any).status, 'selected');
  assert.equal((single.structuredContent as any).choiceId, 'read');
  const batch = await client.callTool({ name: 'fusion_choose_batch', arguments: { requests: [input, { ...input, task: 'Read another known file' }] } });
  assert.deepEqual((batch.structuredContent as any).choices.map((choice: any) => choice.choiceId), ['read', 'read']);
  assert.equal(calls, 2, 'single plus one batched provider call');
});

test('HTTP authenticates before routing, restricts hosts/origins, bounds bodies and serves MCP', async t => {
  const config = loadConfig({ FUSION_HTTP_BEARER_TOKEN: 'test-token' });
  config.http.port = 0; config.http.maxBodyBytes = 1024; config.catalog = [tool];
  const server = await startHttpServer({ router, config });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer test-token', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(`${url}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer test-token', Host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ large: 'x'.repeat(2048) }) })).status, 413);
  const client = new Client({ name: 'http-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer test-token' } } });
  await client.connect(transport);
  const result = await client.callTool({ name: 'fusion_route', arguments: { task: 'a' } });
  assert.equal((result.structuredContent as any).decision.status, 'selected');
  await client.close();
});

test('remote HTTP refuses bearer-only deployments and exposes OAuth discovery without authentication', async t => {
  const insecure = loadConfig({ FUSION_HTTP_HOST: '0.0.0.0', FUSION_HTTP_BEARER_TOKEN: 'secret' });
  await assert.rejects(startHttpServer({ router, config: insecure }), /OAuth/);
  const config = loadConfig({ FUSION_PUBLIC_URL: 'https://fusion.example/mcp', FUSION_OAUTH_ISSUER: 'https://issuer.example', FUSION_OAUTH_AUDIENCE: 'https://fusion.example/mcp', FUSION_OAUTH_JWKS_URL: 'https://issuer.example/keys', FUSION_OAUTH_OWNER_SUBJECT: 'owner', FUSION_OAUTH_SCOPES: 'fusion:route' });
  config.http.port = 0;
  const wrongPath = structuredClone(config); wrongPath.http.publicUrl = 'https://fusion.example/other';
  await assert.rejects(startHttpServer({ router, config: wrongPath }), /\/mcp/);
  const server = await startHttpServer({ router, config });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const metadata = await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, 'https://fusion.example/mcp');
  assert.deepEqual(metadata.authorization_servers, ['https://issuer.example']);
  const blocked = await fetch(`${url}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(blocked.status, 401);
  assert.match(blocked.headers.get('www-authenticate')!, /resource_metadata/);
});

test('authenticated HTTP exposes workspace tools only within its fixed server root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fusion-http-workspace-'));
  const root = join(directory, 'repo');
  await mkdir(root);
  await writeFile(join(root, 'inside.txt'), 'allowed source line\n');
  await writeFile(join(directory, 'outside.txt'), 'private outside line\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'workspace-key' };
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    String(input) === 'https://issuer.example/keys'
      ? new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : realFetch(input, init));
  const config = loadConfig({ FUSION_PUBLIC_URL: 'https://fusion.example/mcp', FUSION_OAUTH_ISSUER: 'https://issuer.example',
    FUSION_OAUTH_AUDIENCE: 'https://fusion.example/mcp', FUSION_OAUTH_JWKS_URL: 'https://issuer.example/keys',
    FUSION_OAUTH_OWNER_SUBJECT: 'owner', FUSION_OAUTH_SCOPES: 'fusion:route', FUSION_MCP_PROFILE: 'full' });
  config.http.port = 0;
  const server = await startHttpServer({ router, config, workspace: new WorkspaceService(root, router) });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  assert.equal((await realFetch(url, { method: 'POST', body: '{}' })).status, 401);
  const token = await new SignJWT({ sub: 'owner', scope: 'fusion:route' }).setProtectedHeader({ alg: 'RS256', kid: 'workspace-key' })
    .setIssuer('https://issuer.example').setAudience('https://fusion.example/mcp').setExpirationTime('5m').sign(privateKey);
  const client = new Client({ name: 'remote-workspace-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 15);
  const inside = await client.callTool({ name: 'fusion_read_file', arguments: { path: 'inside.txt' } });
  assert.match((inside.content as any)[0].text, /allowed source line/);
  const outside = await client.callTool({ name: 'fusion_read_file', arguments: { root: directory, path: 'outside.txt' } });
  assert.equal(outside.isError, true);
  assert.doesNotMatch(JSON.stringify(outside), /private outside line/);
  const assistOutside = await client.callTool({ name: 'fusion_assist', arguments: { root: directory, task: 'Read outside.txt' } });
  assert.equal(assistOutside.isError, true);
  assert.doesNotMatch(JSON.stringify(assistOutside), /private outside line/);
  const traversal = await client.callTool({ name: 'fusion_read_file', arguments: { path: '../outside.txt' } });
  assert.equal(traversal.isError, true);
});

test('HTTP admission bounds pending OAuth verification and releases rejected requests', async t => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'admission-key' };
  let releaseKeys!: () => void;
  const keysReady = new Promise<void>(resolve => { releaseKeys = resolve; });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== 'https://issuer.example/keys') return realFetch(input, init);
    await keysReady;
    return new Response(JSON.stringify({ keys: [key] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const config = loadConfig({ FUSION_PUBLIC_URL: 'https://fusion.example/mcp', FUSION_OAUTH_ISSUER: 'https://issuer.example', FUSION_OAUTH_AUDIENCE: 'https://fusion.example/mcp', FUSION_OAUTH_JWKS_URL: 'https://issuer.example/keys', FUSION_OAUTH_OWNER_SUBJECT: 'owner', FUSION_OAUTH_SCOPES: 'fusion:route' });
  config.http.port = 0; config.routing.maxConcurrency = 1;
  const server = await startHttpServer({ router, config });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const token = await new SignJWT({ sub: 'owner', scope: 'fusion:route' }).setProtectedHeader({ alg: 'RS256', kid: 'admission-key' }).setIssuer('https://issuer.example').setAudience('https://fusion.example/mcp').setExpirationTime('5m').sign(privateKey);
  const call = () => realFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
  let arrived = 0;
  let allArrived!: () => void;
  const arrivals = new Promise<void>(resolve => { allArrived = resolve; });
  server.on('request', () => { if (++arrived === 4) allArrived(); });
  const pending = Array.from({ length: 4 }, call);
  await arrivals;
  const overflow = call();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([overflow.then(response => response.status), new Promise<number>(resolve => { timer = setTimeout(() => resolve(0), 250); })]);
    assert.equal(status, 503, 'over-capacity requests must be rejected before waiting for JWKS');
  } finally {
    clearTimeout(timer); releaseKeys();
    await Promise.all([...pending, overflow].map(async request => { const response = await request; await response.text(); }));
  }
  for (let i = 0; i < 6; i++) {
    const response = await realFetch(url, { method: 'POST', body: '{}' });
    assert.equal(response.status, 401); await response.text();
  }
  const response = await call();
  assert.notEqual(response.status, 503, 'failed authentication and malformed MCP requests must release admission');
  await response.text();
});
