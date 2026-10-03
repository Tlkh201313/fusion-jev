import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitBlocks,
  manifestEntryPoints,
  rankSources,
  renderDependencyRows,
  type DependencyEdge,
} from '../src/overview.js';

const discovered = [
  'src/assist.ts',
  'src/cli.ts',
  'src/config.ts',
  'src/index.ts',
  'src/mcp.ts',
  'src/router.ts',
  'src/types.ts',
];

test('package bin, main and exports targets map from build output back to discovered sources, bin first', () => {
  const manifest = JSON.stringify({
    types: './dist/index.d.ts',
    bin: { tool: 'dist/cli.js' },
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    main: './dist/missing.js',
  });
  assert.deepEqual(manifestEntryPoints(manifest, discovered), ['src/cli.ts', 'src/index.ts']);
  assert.deepEqual(manifestEntryPoints(JSON.stringify({ bin: './bin/../src/cli.ts' }), discovered), ['src/cli.ts']);
  assert.deepEqual(manifestEntryPoints(JSON.stringify({ main: '../outside/index.js' }), discovered), []);
  assert.deepEqual(manifestEntryPoints('{ not json', discovered), []);
});

test('manifest entry points lead the ranked sources ahead of conventional names', () => {
  assert.deepEqual(rankSources(discovered, ['src/cli.ts', 'src/index.ts']).slice(0, 4), [
    'src/cli.ts',
    'src/index.ts',
    'src/mcp.ts',
    'src/router.ts',
  ]);
  assert.deepEqual(rankSources(discovered).slice(0, 3), ['src/index.ts', 'src/cli.ts', 'src/mcp.ts']);
});

test('a wide barrel row cannot crowd the CLI entry row out of a clipped module map', () => {
  const edge = (from: string, to: string, line: number): DependencyEdge => ({ from, to, line, kind: 're-export' });
  const rows = [
    { path: 'src/cli.ts', edges: [edge('src/cli.ts', 'src/mcp.ts', 3)] },
    {
      path: 'src/index.ts',
      edges: Array.from({ length: 40 }, (_, i) => edge('src/index.ts', `src/module-${i}.ts`, i + 1)),
    },
    { path: 'src/mcp.ts', edges: [edge('src/mcp.ts', 'src/router.ts', 2)] },
    { path: 'src/types.ts', edges: [] },
  ];
  const full = renderDependencyRows(rows);
  assert.equal(full.split('\n').length, 3);
  assert.match(full, /src\/module-39\.ts:40/);
  const capped = renderDependencyRows(rows, 6);
  assert.match(capped, /^src\/cli\.ts -> src\/mcp\.ts:3 \(re-export\)$/m);
  assert.match(capped, /src\/index\.ts -> .*src\/module-5\.ts:6 \(re-export\) \(\+34 more\)$/m);
  assert.match(capped, /^src\/mcp\.ts -> /m);
  const files = Array.from({ length: 20 }, (_, i) => ({ label: `File f${i}`, text: 'x'.repeat(2000) }));
  const fitted = fitBlocks([{ label: 'Module dependencies', text: capped }, ...files], 12000).text;
  assert.match(fitted, /src\/cli\.ts ->/);
  assert.match(fitted, /src\/mcp\.ts ->/);
});

test('a tight deep overview keeps the package bin entry row and exported entry symbols', async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createFusionMcpServer } = await import('../src/mcp.js');
  const { loadConfig } = await import('../src/config.js');
  const { WorkspaceService } = await import('../src/workspace.js');
  const root = await mkdtemp(join(tmpdir(), 'fusion-overview-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const modules = Array.from(
    { length: 40 },
    (_, i) => `feature-module-with-a-deliberately-long-name-${String(i).padStart(2, '0')}`,
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      { name: 'demo', type: 'module', bin: { demo: 'dist/tool.js' }, exports: { '.': { import: './dist/index.js' } } },
      null,
      2,
    ),
  );
  await writeFile(join(root, 'src', 'index.ts'), modules.map((name) => `export * from './${name}.js';`).join('\n'));
  await writeFile(join(root, 'src', 'tool.ts'), `import { start } from './server.js';\nstart();\n`);
  await writeFile(
    join(root, 'src', 'server.ts'),
    [
      ...Array.from(
        { length: 12 },
        (_, i) => `function helper${i}(value: number): number {\n  return value + ${i};\n}`,
      ),
      'export function start(): void {',
      '  helper0(1);',
      '}',
    ].join('\n'),
  );
  for (const [i, name] of modules.entries())
    await writeFile(join(root, 'src', `${name}.ts`), `export const value${i} = ${i};\n`);
  const router = {
    async route(): Promise<never> {
      throw new Error('no inference');
    },
    async routeBatch(): Promise<never> {
      throw new Error('no inference');
    },
  };
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
  });
  const client = new Client({ name: 'overview-entry', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: 'fusion_repo_overview',
    arguments: { detail: 'deep', maxChars: 11000 },
  });
  assert.ok(!result.isError);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  const metadata = result.structuredContent as { filesRead: string[]; clipped: string[] };
  assert.deepEqual(metadata.filesRead.slice(0, 3), ['package.json', 'src/tool.ts', 'src/index.ts']);
  assert.match(text, /Wide rows capped/);
  assert.match(text, /^src\/tool\.ts -> src\/server\.ts:1$/m);
  assert.match(text, /^src\/index\.ts -> .*\(\+\d+ more\)$/m);
  assert.match(text, /export function start\(\): void/);
});
