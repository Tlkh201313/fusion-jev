import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const TS =
  Array.from({ length: 160 }, (_, i) =>
    i === 3
      ? 'export function alpha(a: number) {\n  return a + 1;\n}'
      : i === 40
        ? 'export class Box {\n  open() { return 1; }\n  close() { return 2; }\n}'
        : `const filler${i} = ${i};`,
  ).join('\n') + '\n';

async function session(t: { after: (fn: () => Promise<void>) => void }, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-dedupe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const server = createFusionMcpServer({
    router,
    config: loadConfig({}),
    workspace: new WorkspaceService(root, router),
  });
  const client = new Client({ name: 'dedupe', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const inspect = async (...requests: object[]) => {
    const result = await client.callTool({ name: 'fusion_inspect', arguments: { requests } });
    return {
      text: (result.content as any)[0].text as string,
      data: result.structuredContent as any,
      error: result.isError,
    };
  };
  return { root, inspect };
}

test('repeat identical read becomes a one-line unchanged note; fresh re-reads; changes return only changed lines', async (t) => {
  const { root, inspect } = await session(t, { 'a.ts': TS });
  const first = await inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 20 });
  assert.match(first.text, /filler/);
  const again = await inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 20 });
  assert.match(again.text, /a\.ts:1-20 unchanged since request #1 \(sha256 [0-9a-f]{8}\)/);
  assert.ok(again.text.length < first.text.length / 2);
  assert.equal(again.data.evidenceRefs.length, 1, 'the repeat is still captured as a receipt');
  const fresh = await inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 20, fresh: true });
  assert.match(fresh.text, /filler/);
  await writeFile(join(root, 'a.ts'), TS.replace('const filler10 = 10;', 'const filler10 = 99;'));
  const changed = await inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 20 });
  assert.match(changed.text, /changed since request #\d+; 1 of 20 lines differ/);
  assert.match(changed.text, /filler10 = 99/);
  await writeFile(join(root, 'a.ts'), TS.replace('const filler10 = 10;', 'const filler10 = 99;') + 'tail\n');
  const elsewhere = await inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 20 });
  assert.match(elsewhere.text, /unchanged since request #\d+; file changed elsewhere/);
});

test('dedupe memory is per session and bounded to 200 entries', async (t) => {
  const one = await session(t, { 'a.ts': TS });
  await one.inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 5 });
  const other = await session(t, { 'a.ts': TS });
  assert.doesNotMatch(
    (await other.inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 5 })).text,
    /unchanged since/,
  );
  for (let n = 0; n < 205; n++)
    await one.inspect({
      action: 'read',
      path: 'a.ts',
      startLine: 10 + (n % 140),
      maxLines: 1 + Math.floor(n / 140) + 1,
    });
  // The earliest remembered range has been evicted, so it is served in full again.
  assert.doesNotMatch(
    (await one.inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 5 })).text,
    /unchanged since/,
  );
});

test('outline and symbol ops return receipts and dedupe', async (t) => {
  const { inspect } = await session(t, { 'a.ts': TS, 'b.ts': 'export function alpha() {}\n' });
  const outline = await inspect({ action: 'outline', path: 'a.ts' });
  assert.match(outline.text, /alpha/);
  assert.match(outline.text, /Box/);
  assert.equal(outline.data.evidenceRefs[0].receipt.source.kind, 'workspace');
  assert.match((await inspect({ action: 'outline', path: 'a.ts' })).text, /outline unchanged since request #1/);
  const symbol = await inspect({ action: 'symbol', path: 'a.ts', name: 'alpha' });
  assert.match(symbol.text, /return a \+ 1/);
  assert.doesNotMatch(symbol.text, /filler50/);
  assert.equal(symbol.data.evidenceRefs.length, 1);
  const method = await inspect({ action: 'symbol', path: 'a.ts', name: 'Box.close' });
  assert.match(method.text, /return 2/);
  const missing = await inspect({ action: 'symbol', path: 'a.ts', name: 'nothere' });
  assert.equal(missing.data.failed[0], 1);
});

test('an unranged read of a big file leads with a compact outline; ranged reads do not', async (t) => {
  const { inspect } = await session(t, { 'a.ts': TS });
  const big = await inspect({ action: 'read', path: 'a.ts' });
  assert.match(big.text, /Outline of \d+ lines/);
  assert.match(big.text, /alpha:\d+-\d+/);
  const ranged = await inspect({ action: 'read', path: 'a.ts', startLine: 1, maxLines: 10 });
  assert.doesNotMatch(ranged.text, /Outline of/);
});

test('files over 8 MiB are read and outlined by streaming, with a derived receipt', async (t) => {
  const body =
    'export function marker() {\n  return 1;\n}\n' +
    '// filler line of padding text\n'.repeat(300_000) +
    'export function tail_fn() {\n  return 2;\n}\n';
  const { inspect } = await session(t, { 'big.ts': body });
  assert.ok(Buffer.byteLength(body) > 8 * 1024 * 1024);
  const read = await inspect({ action: 'read', path: 'big.ts', startLine: 300_004, maxLines: 4 });
  assert.equal(read.error, undefined);
  assert.match(read.text, /tail_fn/);
  assert.equal(read.data.evidenceRefs[0].receipt.source.kind, 'derived_workspace');
  const outline = await inspect({ action: 'outline', path: 'big.ts' });
  assert.match(outline.text, /marker/);
  assert.match(outline.text, /tail_fn/);
  assert.equal(outline.data.evidenceRefs[0].receipt.source.kind, 'derived_workspace');
});

test('grep ranks definitions first and search reports partial scans, both with receipts', async (t) => {
  const { inspect } = await session(t, {
    'src/a.ts': 'export function fitBlocks() {}\n',
    'src/b.ts': 'fitBlocks();\n',
    'huge.log': 'x\n'.repeat(700_000) + 'fitBlocks\n',
  });
  const grep = await inspect({ action: 'grep', pattern: 'fitBlocks', mode: 'content', topK: 5 });
  assert.ok(
    grep.text.indexOf('src/a.ts') >= 0 && grep.text.indexOf('src/a.ts') < grep.text.indexOf('src/b.ts'),
    'definition ranks first',
  );
  assert.ok(grep.data.evidenceRefs.length >= 2);
  const search = await inspect({ action: 'search', query: 'fitBlocks' });
  assert.match(search.text, /partial|budget|scanned/i);
});
