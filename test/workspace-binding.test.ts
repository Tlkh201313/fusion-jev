import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkspaceService } from '../src/workspace.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');

async function connect(cwd: string, env: Record<string, string>) {
  const client = new Client({ name: 'workspace-binding-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', tsxImport, cli, 'stdio'], cwd,
    env: { PATH: process.env.PATH ?? '', FUSION_ENV_FILE: '', TYPESAFE_API_KEY: '',
      FUSION_FALLBACK: 'host', FUSION_WORKSPACE_ALLOWED_ROOTS: '', ...env }, stderr: 'pipe' });
  await client.connect(transport);
  return client;
}

async function inspect(client: Client, root?: string) {
  return client.callTool({ name: 'fusion_inspect', arguments: {
    ...(root ? { root } : {}), requests: [{ action: 'read', path: 'note.txt' }],
  } });
}

test('Claude adapter binds each session to its project even when the launcher cwd differs', async t => {
  const base = await mkdtemp(join(tmpdir(), 'fusion-project-binding-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const launcher = join(base, 'launcher');
  const projects = [join(base, 'first'), join(base, 'second')];
  await Promise.all([launcher, ...projects].map(path => mkdir(path)));
  await writeFile(join(projects[0]!, 'note.txt'), 'first project evidence');
  await writeFile(join(projects[1]!, 'note.txt'), 'second project evidence');
  const adapter = JSON.parse(await readFile(new URL('../plugin/fusion-jev-claude/.mcp.json', import.meta.url), 'utf8')).mcpServers.fusion;
  for (const [index, project] of projects.entries()) {
    // Claude substitutes its trusted project variable in plugin MCP env values.
    const env = Object.fromEntries(Object.entries(adapter.env as Record<string, string>)
      .map(([key, value]) => [key, value.replaceAll('${CLAUDE_PROJECT_DIR}', project)]));
    const client = await connect(launcher, { CLAUDE_PROJECT_DIR: project, ...env });
    try {
      const implicit = await inspect(client);
      assert.equal(implicit.isError, undefined);
      assert.deepEqual((implicit.structuredContent as any).failed, []);
      assert.match((implicit.content as any)[0].text, index === 0 ? /first project evidence/ : /second project evidence/);
      const denied = await inspect(client, projects[1 - index]);
      assert.equal(denied.isError, true);
      assert.equal((denied.structuredContent as any).error.code, 'INVALID_PATH');
    } finally { await client.close(); }
  }
});

test('Windows canonical approval accepts alternate root casing while retaining exact root isolation',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'Fusion-CaseRoot-'));
    const denied = await mkdtemp(join(tmpdir(), 'fusion-unrelated-'));
    t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(denied, { recursive: true, force: true }); });
    await writeFile(join(root, 'note.txt'), 'approved mixed case evidence');
    const workspace = new WorkspaceService(root.toLowerCase(), { route: async () => { throw new Error('No provider call expected'); } });
    assert.equal((await workspace.snapshot('note.txt')).bytes.toString(), 'approved mixed case evidence');
    const client = await connect(denied, { FUSION_WORKSPACE_ROOT: root });
    try {
      const allowed = await inspect(client, root.toLowerCase());
      assert.equal(allowed.isError, undefined);
      assert.deepEqual((allowed.structuredContent as any).failed, []);
      assert.match((allowed.content as any)[0].text, /approved mixed case evidence/);
      const unrelated = await inspect(client, denied);
      assert.equal(unrelated.isError, true);
      assert.equal((unrelated.structuredContent as any).error.code, 'INVALID_PATH');
    } finally { await client.close(); }
  });
