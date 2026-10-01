import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFusionMcpServer, type RoutingService } from '../src/mcp.js';
import { loadConfig } from '../src/config.js';
import { WorkspaceService } from '../src/workspace.js';

// Fixed per-session context a host loads before any work: tool schemas, server
// instructions and the Claude SessionStart hint. Tokens are a bytes/4 estimate;
// JSON usually tokenizes denser, so treat them as a rough lower bound.
const router: RoutingService = {
  async route() { throw new Error('No provider calls'); },
  async routeBatch() { throw new Error('No provider calls'); },
};
const root = await mkdtemp(join(tmpdir(), 'fusion-overhead-'));
try {
  const rows: Array<{ part: string; bytes: number }> = [];
  for (const profile of ['assist', 'full'] as const) {
    const server = createFusionMcpServer({ router, config: loadConfig({ FUSION_MCP_PROFILE: profile }), workspace: new WorkspaceService(root, router) });
    const client = new Client({ name: 'overhead', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left); await client.connect(right);
    const { tools } = await client.listTools();
    rows.push({ part: `tools/list (${profile}, ${tools.length} tools)`, bytes: Buffer.byteLength(JSON.stringify(tools)) });
    if (profile === 'assist') rows.push({ part: 'server instructions', bytes: Buffer.byteLength(client.getInstructions() ?? '') });
    await client.close(); await server.close();
  }
  const hook = spawnSync(process.execPath, [fileURLToPath(new URL('../plugin/fusion-jev-claude/scripts/session-start.cjs', import.meta.url))], { encoding: 'utf8' });
  rows.push({ part: 'Claude SessionStart hint', bytes: Buffer.byteLength(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext) });
  const session = rows.filter(row => !row.part.includes('full')).reduce((sum, row) => sum + row.bytes, 0);
  for (const row of rows) process.stdout.write(`${row.part.padEnd(34)} ${String(row.bytes).padStart(6)} B  ~${Math.round(row.bytes / 4)} tok\n`);
  process.stdout.write(`${'default Claude session total'.padEnd(34)} ${String(session).padStart(6)} B  ~${Math.round(session / 4)} tok (bytes/4 estimate)\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
