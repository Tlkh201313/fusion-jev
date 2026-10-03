import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssistanceService } from '../src/assist.js';
import { WorkspaceService } from '../src/workspace.js';
import { EvidenceStore } from '../src/evidence.js';
import { createFusionMcpServer } from '../src/mcp.js';
import type { RoutingService } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RouteRequest, RouteResult } from '../src/types.js';

async function fixture(t: TestContext, respond?: (request: RouteRequest) => RouteResult) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-delegation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'small.ts'), 'export const answer = 42;\n');
  const requests: RouteRequest[] = [];
  const router: RoutingService = {
    async route(request) {
      requests.push(request);
      const candidate = request.candidates![0]!;
      return (
        respond?.(request) ?? {
          decision: {
            status: 'selected',
            source: 'jev',
            candidateId: candidate.id,
            call: { tool: candidate.tool, arguments: candidate.arguments },
          },
          usage: [],
          latencyMs: 1,
        }
      );
    },
    async routeBatch() {
      throw new Error('Unexpected batch');
    },
  };
  const evidence = new EvidenceStore();
  const assist = new AssistanceService(new WorkspaceService(root, router), router, evidence, undefined, {
    delegateKnownActions: true,
  });
  return { root, router, requests, evidence, assist };
}

test('configured routine reads, lists and searches each route through Jev', async (t) => {
  const { assist, requests } = await fixture(t);
  for (const task of ['Read src/small.ts', 'List src', 'Find answer']) {
    const result = await assist.assist({ task, scope: 'src' });
    assert.equal(result.status, 'evidence');
    assert.equal(result.telemetry.jevCalls, 1);
    assert.ok(result.evidenceIds.length > 0);
  }
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.strategy === 'jev-only' && request.cache === false));
});

test('a declined or forged known read cannot silently bypass Jev', async (t) => {
  for (const forged of [false, true]) {
    const { assist } = await fixture(t, (request) => ({
      decision: forged
        ? {
            status: 'selected',
            source: 'jev',
            candidateId: request.candidates![0]!.id,
            call: { tool: 'assist_action', arguments: { id: request.candidates![0]!.id, extra: 'forged' } },
          }
        : { status: 'escalate', source: 'host', reason: 'provider_error' },
      usage: [],
      latencyMs: 1,
    }));
    const result = await assist.assist({ task: 'Read src/small.ts' });
    assert.equal(result.status, 'escalate');
    assert.equal(result.telemetry.jevCalls, 1);
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.evidenceIds, []);
  }
});

test('exact host command plans use Jev and preserve argv without server execution', async (t) => {
  const { root, assist, requests } = await fixture(t);
  const marker = join(root, 'must-not-exist.txt');
  const argv = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`];
  const result = await assist.assist({ task: 'Run the supplied node command', command: { program: 'node', argv } });
  assert.equal(result.telemetry.jevCalls, 1);
  assert.equal(requests.length, 1);
  assert.equal(result.hostAction?.kind, 'command');
  assert.deepEqual(result.hostAction?.argv, ['node', ...argv]);
  assert.deepEqual(result.hostAction?.execution, {
    program: 'fusion-jev',
    argv: ['run', `--cwd=${root}`, '--', 'node', ...argv],
  });
  await assert.rejects(readFile(marker));
});

test('Jev selects grounded check recipes instead of choosing the first recipe locally', async (t) => {
  const { root, assist, requests } = await fixture(t, (request) => {
    const selected = request.candidates!.find((candidate) => candidate.description?.includes('test:unit'))!;
    assert.ok(selected);
    return {
      decision: {
        status: 'selected',
        source: 'jev',
        candidateId: selected.id,
        call: { tool: selected.tool, arguments: selected.arguments },
      },
      usage: [],
      latencyMs: 1,
    };
  });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', 'test:unit': 'node --test unit' } }),
  );
  const result = await assist.assist({ task: 'Run unit tests' });
  assert.equal(result.telemetry.jevCalls, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.hostAction?.argv, ['npm', 'run', 'test:unit']);
  assert.match(result.hostAction!.sourceSha256!, /^[a-f0-9]{64}$/);
});

test('the normal MCP profile delegates known tasks when the provider is configured', async (t) => {
  const { root, router, evidence, requests } = await fixture(t);
  const server = createFusionMcpServer({
    router,
    config: loadConfig({ TEAMOROUTER_API_KEY: 'fixture-key', TYPESAFE_API_KEY: 'fixture-key' }),
    workspace: new WorkspaceService(root, router),
    evidence,
  });
  const client = new Client({ name: 'routine-delegation-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const advertised = (await client.listTools()).tools.find((tool) => tool.name === 'fusion_assist')!;
    const commandSchema = (advertised.inputSchema.properties as any)?.command;
    assert.ok(
      commandSchema?.properties?.program && commandSchema?.properties?.argv,
      'Schema-driven hosts must see the exact command plan inputs',
    );
    for (const arguments_ of [
      { task: 'Read src/small.ts' },
      { task: 'Run node --version', command: { program: 'node', argv: ['--version'] } },
    ]) {
      const result = await client.callTool({ name: 'fusion_assist', arguments: arguments_ });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as any).telemetry.jevCalls, 1);
      assert.notEqual((result.structuredContent as any).status, 'escalate');
    }
    assert.equal(requests.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});
