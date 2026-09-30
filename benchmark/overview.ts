import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFusionMcpServer, type RoutingService } from '../src/mcp.js';
import { loadConfig } from '../src/config.js';
import { WorkspaceService } from '../src/workspace.js';

// Identical checkout for every mode; no provider, file cache or host-model simulation.
// --baseline-dist optionally compares the previously compiled build BEFORE rebuilding it.
let providerCalls = 0;
const router: RoutingService = {
  async route() { providerCalls++; throw new Error('Overview must not infer'); },
  async routeBatch() { providerCalls++; throw new Error('Overview must not infer'); },
};
const sessions: Array<{ client: Client; server: ReturnType<typeof createFusionMcpServer> }> = [];
async function session(factory: typeof createFusionMcpServer, Service: typeof WorkspaceService) {
  const server = factory({ router, config: loadConfig({}), workspace: new Service(process.cwd(), router) });
  const client = new Client({ name: 'overview-benchmark', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  sessions.push({ client, server });
  return client;
}
try {
  const current = await session(createFusionMcpServer, WorkspaceService);
  const modes = [{ name: 'standard', client: current, args: {} }, { name: 'deep', client: current, args: { detail: 'deep' } }];
  if (process.argv.includes('--baseline-dist')) {
    const oldMcp = await import(new URL('../dist/mcp.js', import.meta.url).href);
    const oldWorkspace = await import(new URL('../dist/workspace.js', import.meta.url).href);
    modes.push({ name: 'previousBuildDefault', client: await session(oldMcp.createFusionMcpServer, oldWorkspace.WorkspaceService), args: {} });
  }
  const results = new Map<string, { samples: number[]; bytes: number; textChars: number; files: number; edges?: number; clipped: string[] }>();
  for (let round = 0; round < 10; round++) for (let turn = 0; turn < modes.length; turn++) {
    const mode = modes[(round + turn) % modes.length]!;
    const start = performance.now();
    const result = await mode.client.callTool({ name: 'fusion_repo_overview', arguments: mode.args });
    const elapsed = performance.now() - start;
    assert.ok(!result.isError);
    const metadata = result.structuredContent as any;
    assert.equal(metadata.modelCalls, 0);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    if (mode.name !== 'previousBuildDefault') {
      assert.match(text, /Module dependencies/);
      assert.match(text, /src\/cli.ts ->/);
      assert.match(text, /FusionRouter/);
      assert.match(text, /createFusionMcpServer/);
    }
    const previous = results.get(mode.name);
    results.set(mode.name, { samples: [...(previous?.samples ?? []), ...(round >= 2 ? [elapsed] : [])],
      bytes: Buffer.byteLength(JSON.stringify(result)), textChars: text.length,
      files: metadata.coverage.sourceFilesOutlined, edges: metadata.coverage.dependencyEdges, clipped: metadata.clipped });
  }
  assert.equal(providerCalls, 0);
  assert.equal(results.get('standard')!.edges, results.get('deep')!.edges);
  assert.equal(results.get('standard')!.files, results.get('deep')!.files);
  const baseline = results.get('previousBuildDefault');
  const summary = Object.fromEntries([...results].map(([name, result]) => {
    const ordered = [...result.samples].sort((a, b) => a - b);
    return [name, { responseBytes: result.bytes, textChars: result.textChars, sourcesOutlined: result.files,
      dependencyEdges: result.edges, clipped: result.clipped,
      p50Ms: +ordered[Math.floor(ordered.length * .5)]!.toFixed(2),
      p95Ms: +ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * .95))]!.toFixed(2),
      ...(baseline ? { byteReductionVsPreviousPercent: +(100 * (1 - result.bytes / baseline.bytes)).toFixed(1) } : {}) }];
  }));
  console.log(JSON.stringify({ kind: 'local-overview-efficiency', fixture: 'current checkout', providerCalls,
    note: 'Rotated execution, warm filesystem, no result cache. Same discovered modules and static edges in standard/deep. Bytes are not billed tokens. Timings exclude host reasoning and network.', results: summary }, null, 2));
} finally { for (const { client, server } of sessions) { await client.close(); await server.close(); } }
