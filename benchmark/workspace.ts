import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createFusionMcpServer, type RoutingService } from '../src/mcp.js';
import { WorkspaceService } from '../src/workspace.js';

// Real local I/O and MCP encoding, no model simulation and no provider requests.
const root = await mkdtemp(join(tmpdir(), 'fusion-efficiency-'));
let providerCalls = 0;
const router: RoutingService = {
  async route() {
    providerCalls++;
    throw new Error('Workspace reads must not call a provider');
  },
  async routeBatch() {
    providerCalls++;
    throw new Error('Workspace reads must not call a provider');
  },
};
const service = new WorkspaceService(root, router);
const server = createFusionMcpServer({ router, config: loadConfig({}), workspace: service });
const client = new Client({ name: 'efficiency-benchmark', version: '1' });
const [left, right] = InMemoryTransport.createLinkedPair();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
try {
  const fixtures = Array.from({ length: 4 }, (_, i) => ({
    path: `module-${i}.ts`,
    text: Array.from(
      { length: 40 },
      (_, line) => `export const item_${i}_${line} = "exact evidence ${i}:${line}";`,
    ).join('\n'),
  }));
  await Promise.all(fixtures.map((f) => writeFile(join(root, f.path), f.text)));
  await server.connect(left);
  await client.connect(right);
  const results: Record<string, { samples: number[]; responseBytes: number }> = {
    previousDuplicateEncoding: { samples: [], responseBytes: 0 },
    compactDirect: { samples: [], responseBytes: 0 },
    inspectionBatch: { samples: [], responseBytes: 0 },
  };
  const modes = Object.keys(results);
  for (let round = 0; round < 12; round++)
    for (let turn = 0; turn < modes.length; turn++) {
      const mode = modes[(round + turn) % modes.length]!;
      const start = performance.now();
      let payload: unknown;
      if (mode === 'previousDuplicateEncoding') {
        // Reconstruct the previous representation over the same current reader; not an old runtime latency measurement.
        payload = await Promise.all(
          fixtures.map(async (f) => {
            const result = await service.read(f.path);
            return {
              content: [{ type: 'text', text: result.lines.map((l) => `${l.number}: ${l.text}`).join('\n') }],
              structuredContent: result,
            };
          }),
        );
      } else if (mode === 'compactDirect') {
        payload = await Promise.all(
          fixtures.map((f) => client.callTool({ name: 'fusion_read_file', arguments: { path: f.path } })),
        );
      } else {
        payload = await client.callTool({
          name: 'fusion_inspect',
          arguments: { requests: fixtures.map((f) => ({ action: 'read', path: f.path })) },
        });
        assert.deepEqual((payload as any).structuredContent.clipped, []);
      }
      const encoded = JSON.stringify(payload);
      for (const f of fixtures)
        for (const line of f.text.split('\n'))
          assert.ok(encoded.includes(JSON.stringify(line).slice(1, -1)), 'Every exact source line must survive');
      if (round > 1) results[mode]!.samples.push(performance.now() - start);
      results[mode]!.responseBytes = bytes(payload);
    }
  assert.equal(providerCalls, 0);
  const baseline = results.previousDuplicateEncoding!.responseBytes;
  const summary = Object.fromEntries(
    Object.entries(results).map(([name, result]) => {
      const ordered = [...result.samples].sort((a, b) => a - b);
      return [
        name,
        {
          responseBytes: result.responseBytes,
          evidencePreserved: true,
          responseByteReductionPercent: Number((100 * (1 - result.responseBytes / baseline)).toFixed(1)),
          ...(name === 'previousDuplicateEncoding'
            ? { reconstructedEncodingOnly: true }
            : {
                p50Ms: Number(ordered[Math.floor(ordered.length * 0.5)]!.toFixed(2)),
                p95Ms: Number(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))]!.toFixed(2)),
                toolCalls: name === 'inspectionBatch' ? 1 : 4,
              }),
        },
      ];
    }),
  );
  console.log(
    JSON.stringify(
      {
        kind: 'local-workspace-efficiency',
        fixture: 'four 40-line files',
        providerCalls,
        note: 'Bytes are measured serialized MCP output, not billed tokens or subscription savings. Local warm-file timings exclude host reasoning and external transport. No output cache.',
        results: summary,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
