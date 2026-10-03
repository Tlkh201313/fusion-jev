import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyEdges, fitBlocks } from '../src/overview.js';

test('module graph preserves actual static edges, multiline imports and type boundaries without invented comment/string edges', () => {
  const text = [
    '// import fake from "./fake.js";',
    '/*',
    'import fake from "./fake.js";',
    '*/',
    'const example = `',
    'import fake from "./fake.js";',
    '`;',
    'import {',
    '  route,',
    '} from "./router.js";',
    'import type { Request } from "./types.js";',
    'export * from "./providers/index.js";',
    'import "./init.js";',
    'import external from "package";',
    'import missing from "./missing.js";',
    'const dynamic = import("./dynamic.js");',
  ].join('\n');
  const files = new Set([
    'src/router.ts',
    'src/types.ts',
    'src/providers/index.ts',
    'src/init.ts',
    'src/fake.ts',
    'src/dynamic.ts',
  ]);
  const result = dependencyEdges(
    'src/index.ts',
    text.split('\n').map((text, i) => ({ number: i + 1, text })),
    files,
  );
  assert.deepEqual(result, {
    supported: true,
    unresolved: 1,
    edges: [
      { from: 'src/index.ts', to: 'src/router.ts', line: 8, kind: 'import' },
      { from: 'src/index.ts', to: 'src/types.ts', line: 11, kind: 'type' },
      { from: 'src/index.ts', to: 'src/providers/index.ts', line: 12, kind: 're-export' },
      { from: 'src/index.ts', to: 'src/init.ts', line: 13, kind: 'import' },
    ],
  });
  assert.equal(dependencyEdges('src/main.py', [], files).supported, false);
});

test('evidence budget retains every line when complete output fits and marks every clipped block', () => {
  const blocks = [
    { label: '1 read', text: 'x'.repeat(1900) },
    { label: '2 read', text: 'small' },
  ];
  const result = fitBlocks(blocks, 2000);
  assert.deepEqual(result.clipped, []);
  assert.ok(result.text.includes(blocks[0]!.text));
  const limited = fitBlocks(blocks, 500);
  assert.ok(limited.text.length <= 500);
  assert.deepEqual(limited.clipped, ['1 read']);
  assert.match(limited.text, /small/);
  assert.ok(fitBlocks([{ label: 'x'.repeat(3000), text: 'body' }], 2000).text.length <= 2000);
});

test('unrelated export declarations cannot swallow a following import into a false re-export', () => {
  const text = [
    'export default class Example {}',
    'import value from "./value.js"',
    'import { type OnlyType } from "./types.js"',
    'import { type SomeType, value } from "./mixed.js"',
    'import {} from "./empty.js"',
  ];
  const result = dependencyEdges(
    'src/index.ts',
    text.map((text, i) => ({ number: i + 1, text })),
    new Set(['src/value.ts', 'src/types.ts', 'src/mixed.ts', 'src/empty.ts']),
  );
  assert.deepEqual(
    result.edges.map((edge) => ({ line: edge.line, kind: edge.kind })),
    [
      { line: 2, kind: 'import' },
      { line: 3, kind: 'type' },
      { line: 4, kind: 'import' },
      { line: 5, kind: 'import' },
    ],
  );
});
