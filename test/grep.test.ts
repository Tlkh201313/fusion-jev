import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.js';
import { classifyHit, compileSafeRegex, globMatcher, rankHits, UnsafePatternError } from '../src/grep.js';
import type { RouteResult } from '../src/types.js';

const noProvider = { route: async (): Promise<RouteResult> => { throw new Error('No provider calls expected'); } };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-grep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return new WorkspaceService(root, noProvider);
}

test('pattern safety refuses catastrophic, back-referencing, empty-matching and oversized patterns', () => {
  for (const bad of ['(a+)+$', '(a*)*b', '(x|xx)+y', '((a+)b)+', '(a)\\1', 'a'.repeat(201), '(', 'a+b+c+d+e+f+g+', '(?:\\w+\\s?){2,}$'])
    assert.throws(() => compileSafeRegex(bad, false), UnsafePatternError, bad);
  for (const good of ['fitBlocks\\(', '^export\\s+(?:async\\s+)?function\\s+\\w+', '(foo|bar)baz', '(\\d{1,3}\\.){3}\\d+', 'a{2}', '[(+*]+x', '(abc)?d*'])
    assert.ok(compileSafeRegex(good, true) instanceof RegExp, good);
});

test('glob matching: base-name globs, path globs, double star and braces', () => {
  const ts = globMatcher('*.ts');
  assert.ok(ts('src/a.ts') && ts('a.ts') && !ts('src/a.tsx'));
  const nested = globMatcher('src/**/*.{ts,tsx}');
  assert.ok(nested('src/a/b/c.tsx') && nested('src/c.ts') && !nested('lib/c.ts'));
  assert.ok(globMatcher('src/*.ts')('src/a.ts') && !globMatcher('src/*.ts')('src/x/a.ts'));
});

test('classification and ranking: definitions and whole words first, then one hit per file before any second hit', () => {
  assert.deepEqual(classifyHit('export function fitBlocks(a) {', 16, 9), { definition: true, exactWord: true, tier: 3 });
  assert.deepEqual(classifyHit('  const x = fitBlocksAll(1);', 12, 9), { definition: false, exactWord: false, tier: 0 });
  assert.equal(classifyHit('  return fitBlocks(x);', 9, 9).tier, 1);
  const ranked = rankHits([
    { path: 'b.ts', line: 1, tier: 1 }, { path: 'a.ts', line: 1, tier: 1 }, { path: 'a.ts', line: 2, tier: 1 },
    { path: 'z.ts', line: 9, tier: 3 }, { path: 'c.ts', line: 5, tier: 0 },
  ]);
  assert.deepEqual(ranked.map(hit => `${hit.path}:${hit.line}`), ['z.ts:9', 'a.ts:1', 'b.ts:1', 'a.ts:2', 'c.ts:5']);
});

test('grep ranks definitions first, supports glob, ignoreCase, context, files and count modes', async t => {
  const service = await fixture(t, {
    'src/core.ts': 'export function fitBlocks(a: number) {\n  return a;\n}\n',
    'src/use.ts': 'import { fitBlocks } from "./core.js";\nfitBlocks(1);\nfitBlocks(2);\nfitBlocks(3);\n',
    'docs/notes.md': 'about FITBLOCKS here\n',
    'src/other.ts': 'const x = 1;\n',
    'data.bin': Buffer.from([0, 1, 2, 3]),
  });
  const content = await service.grep({ pattern: 'fitBlocks\\(' });
  assert.equal(content.mode, 'content');
  assert.deepEqual(content.matches.slice(0, 2).map(hit => `${hit.path}:${hit.line}`), ['src/core.ts:1', 'src/use.ts:2'], 'definition first, then one hit per file');
  assert.equal(content.matches[0]!.definition, true);
  assert.equal(content.totalMatches, 4);
  assert.equal(content.skippedFiles, 1, 'binary file is reported, not hidden');

  const limited = await service.grep({ pattern: 'fitblocks', ignoreCase: true, glob: '*.md' });
  assert.deepEqual(limited.matches.map(hit => hit.path), ['docs/notes.md']);

  const files = await service.grep({ pattern: 'fitBlocks', mode: 'files', topK: 2 });
  assert.deepEqual(files.files.map(file => file.path), ['src/core.ts', 'src/use.ts']);
  assert.equal(files.filesMatched, 2 + 0, 'case-sensitive: the markdown file does not match');
  assert.equal(files.matches.length, 0);

  const counts = await service.grep({ pattern: 'fitBlocks', mode: 'count' });
  assert.deepEqual(counts.files, [{ path: 'src/use.ts', count: 4 }, { path: 'src/core.ts', count: 1 }]);

  const withContext = await service.grep({ pattern: 'return a', contextLines: 1 });
  assert.deepEqual(withContext.matches[0]!.context?.map(line => line.line), [1, 2, 3]);

  const one = await service.grep({ pattern: 'fitBlocks', topK: 1 });
  assert.equal(one.matches.length, 1);
  assert.equal(one.truncated, true);
});

test('grep rejects unsafe or invalid requests with INVALID_REQUEST', async t => {
  const service = await fixture(t, { 'a.txt': 'x\n' });
  for (const options of [{ pattern: '(a+)+' }, { pattern: 'x*' }, { pattern: '[' }, { pattern: 'x', mode: 'nope' as any },
    { pattern: 'x', contextLines: 4 }, { pattern: 'x', topK: 51 }, { pattern: 'x', glob: '' }])
    await assert.rejects(service.grep(options), (error: any) => error.code === 'INVALID_REQUEST', JSON.stringify(options));
  await assert.rejects(service.grep({ pattern: 'x', path: '../outside' }), (error: any) => error.code === 'INVALID_PATH');
});

test('grep never reads secrets or build output, and honours confinement', async t => {
  const service = await fixture(t, {
    '.env': 'TOKEN_NEEDLE\n', 'node_modules/p/index.js': 'TOKEN_NEEDLE\n', 'dist/out.js': 'TOKEN_NEEDLE\n', 'src/ok.ts': 'TOKEN_NEEDLE\n',
  });
  const result = await service.grep({ pattern: 'TOKEN_NEEDLE' });
  assert.deepEqual(result.matches.map(hit => hit.path), ['src/ok.ts']);
  await assert.rejects(service.grep({ pattern: 'TOKEN_NEEDLE', path: '.env' }), (error: any) => error.code === 'INVALID_PATH');
});

test('files over the per-file limit are scanned within a byte budget and reported, never silently skipped', async t => {
  const small = 'filler line\n'.repeat(30_000); // ~360 KB, over the 256 KB direct-read limit
  const huge = 'filler line\n'.repeat(120_000) + 'LATE_NEEDLE\n'; // ~1.4 MB: needle lies beyond the 1 MiB scan budget
  const service = await fixture(t, {
    'mid.log': small + 'MID_NEEDLE\n', 'huge.log': 'EARLY_NEEDLE\n' + huge, 'tiny.txt': 'MID_NEEDLE\n',
  });
  const grep = await service.grep({ pattern: 'MID_NEEDLE|EARLY_NEEDLE|LATE_NEEDLE' });
  assert.deepEqual(grep.matches.map(hit => hit.path).sort(), ['huge.log', 'mid.log', 'tiny.txt']);
  assert.equal(grep.partialFiles, 1);
  assert.deepEqual(grep.partialPaths, ['huge.log']);
  assert.equal(grep.truncated, true);
  assert.deepEqual([...(grep.uncaptured ?? [])].sort(), ['huge.log', 'mid.log']);
  assert.ok(!grep.matches.some(hit => hit.line > 120_000), 'the late needle past the budget is not claimed');

  const search = await service.search('LATE_NEEDLE');
  assert.equal(search.matches.length, 0);
  assert.equal(search.partialFiles, 1, 'search reports the partially scanned file');
  assert.equal(search.skippedFiles, 0);
  assert.equal(search.truncated, true);
  const early = await service.search('EARLY_NEEDLE');
  assert.deepEqual(early.matches.map(match => match.path), ['huge.log']);
});
