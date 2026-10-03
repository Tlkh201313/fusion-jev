import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createFusionMcpServer } from '../src/mcp.js';
import { WorkspaceService } from '../src/workspace.js';
import type { RouteResult } from '../src/types.js';

const router = {
  route: async (): Promise<RouteResult> => {
    throw new Error('No provider calls expected');
  },
} as unknown as import('../src/mcp.js').RoutingService;
const SCHEMA_BUDGET_CHARS = 2800;
const INSTRUCTION_BUDGET_CHARS = 600;

test('default assist profile keeps tools/list and instructions under a fixed-cost budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
  });
  const client = new Client({ name: 'budget', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['fusion_assist', 'fusion_inspect', 'fusion_evidence'],
  );
  const size = JSON.stringify(tools).length;
  assert.ok(size <= SCHEMA_BUDGET_CHARS, `assist tools/list is ${size} chars, budget ${SCHEMA_BUDGET_CHARS}`);
  assert.ok((client.getInstructions() ?? '').length <= INSTRUCTION_BUDGET_CHARS);
  const inspect = tools.find((tool) => tool.name === 'fusion_inspect')!;
  for (const op of ['outline', 'symbol', 'grep'])
    assert.ok(JSON.stringify(inspect.inputSchema).includes(`"${op}"`), op);
  // Slim advertising must not loosen validation: the registered schemas still reject bad calls.
  for (const args of [
    { requests: [{ action: 'grep', pattern: 'x', topK: 99 }] },
    { requests: [{ action: 'read', path: 'a', extra: 1 }] },
    { requests: [] },
  ])
    assert.equal(
      (await client.callTool({ name: 'fusion_inspect', arguments: args })).isError,
      true,
      JSON.stringify(args),
    );
});
