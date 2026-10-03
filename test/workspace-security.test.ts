import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir } from './helpers/tmp.js';
import { initGitRepo } from './helpers/git.js';
import { setEnv, setPathFirst } from './helpers/env.js';
import { WorkspaceService } from '../src/workspace.js';
import type { RouteRequest, RouteResult } from '../src/types.js';

const noProvider = { route: async (): Promise<RouteResult> => { throw new Error('No provider calls expected'); } };
async function fixture(t: TestContext) {
  const root = await makeTempDir(t, 'fusion-security-');
  const git = initGitRepo(root);
  return { root, git, service: new WorkspaceService(root, noProvider) };
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test('Git directory scopes exclude secret paths from unstaged, staged, and deleted changes', async t => {
  const { root, git, service } = await fixture(t);
  const blocked = ['.env', '.env.local', 'nested/.ENV.test', 'nested/.npmrc',
    'nested/.superpowers/private.txt', 'dist/private.txt', 'nested/.aws/private.txt'];
  for (const path of [...blocked, 'public.txt', 'nested/public.txt']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), blocked.includes(path) ? 'PRIVATE_FIXTURE_BEFORE\n' : 'public-before\n');
  }
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  for (const path of blocked) await writeFile(join(root, path), 'PRIVATE_FIXTURE_STAGED\n');
  await writeFile(join(root, 'public.txt'), 'public-staged\n');
  await writeFile(join(root, 'nested/public.txt'), 'nested-staged\n');
  git(['add', '.']);
  for (const path of blocked) await writeFile(join(root, path), 'PRIVATE_FIXTURE_UNSTAGED\n');
  await writeFile(join(root, 'public.txt'), 'public-unstaged\n');
  await writeFile(join(root, 'nested/public.txt'), 'nested-unstaged\n');
  for (const path of ['.', 'nested']) for (const staged of [false, true]) {
    const result = await service.git('diff', undefined, { path, staged });
    assert.doesNotMatch(result.text, /PRIVATE_FIXTURE|\.ENV\.test|\.env|\.npmrc|private\.txt/);
    assert.match(result.text, staged ? /\+nested-staged/ : /\+nested-unstaged/);
  }
  for (const path of blocked) await rm(join(root, path));
  git(['add', '-u']);
  assert.doesNotMatch((await service.git('diff', undefined, { staged: true })).text, /PRIVATE_FIXTURE|private\.txt/);
  assert.doesNotMatch((await service.git('status')).text, /\.env|\.ENV\.test|\.npmrc|private\.txt/);
});

test('Git history omits commits affecting only excluded files', async t => {
  const { root, git, service } = await fixture(t);
  await writeFile(join(root, 'public.txt'), 'ordinary\n');
  git(['add', '.']); git(['commit', '-qm', 'public fixture']);
  await writeFile(join(root, '.env'), 'PRIVATE_FIXTURE\n');
  git(['add', '.env']); git(['commit', '-qm', 'PRIVATE_FIXTURE_COMMIT']);
  const result = await service.git('log');
  assert.match(result.text, /public fixture/);
  assert.doesNotMatch(result.text, /PRIVATE_FIXTURE_COMMIT/);
});

test('Git literal scopes retain bracket characters while excluding secret siblings', async t => {
  const { root, git, service } = await fixture(t);
  for (const path of ['[special].txt', 's.txt', '.env']) await writeFile(join(root, path), 'before\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  await writeFile(join(root, '[special].txt'), 'literal-change\n');
  await writeFile(join(root, 's.txt'), 'sibling-change\n');
  await writeFile(join(root, '.env'), 'PRIVATE_FIXTURE\n');
  const result = await service.git('diff', undefined, { path: '[special].txt' });
  assert.match(result.text, /\+literal-change/);
  assert.doesNotMatch(result.text, /sibling-change|PRIVATE_FIXTURE/);
});

test('Git diff never executes a repository fsmonitor helper', async t => {
  const { root, git, service } = await fixture(t);
  await writeFile(join(root, 'public.txt'), 'before\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  await writeFile(join(root, 'public.txt'), 'after\n');
  const marker = join(root, 'monitor-ran.txt');
  const helper = join(root, 'monitor.sh');
  await writeFile(helper, `#!/bin/sh\nprintf harmless > '${marker.replaceAll('\\', '/')}'\nexit 1\n`, { mode: 0o755 });
  git(['config', 'core.fsmonitor', helper.replaceAll('\\', '/')]);
  git(['diff']);
  assert.equal(await exists(marker), true, 'fixture monitor is executable');
  await rm(marker);
  assert.match((await service.git('diff')).text, /\+after/);
  assert.equal(await exists(marker), false, 'inspection must not invoke fsmonitor');
  await service.search('after');
  assert.equal(await exists(marker), false, 'Git inventory must not invoke fsmonitor');
  await service.git('status');
  assert.equal(await exists(marker), false, 'Git status must not invoke fsmonitor');
});

test('Git log never executes a repository signature verifier', async t => {
  const { root, git, service } = await fixture(t);
  await writeFile(join(root, 'public.txt'), 'before\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  await writeFile(join(root, 'public.txt'), 'after\n'); git(['add', 'public.txt']);
  const tree = git(['write-tree']);
  const parent = git(['rev-parse', 'HEAD']);
  const oid = git(['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nparent ${parent}\nauthor Fixture <security@example.invalid> 1 +0000\ncommitter Fixture <security@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n harmless\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`);
  git(['update-ref', 'HEAD', oid]);
  const marker = join(root, 'verifier-ran.txt');
  const helper = join(root, 'verify.sh');
  await writeFile(helper, `#!/bin/sh\nprintf harmless > '${marker.replaceAll('\\', '/')}'\nexit 1\n`, { mode: 0o755 });
  git(['config', 'gpg.program', helper.replaceAll('\\', '/')]);
  git(['config', 'log.showSignature', 'true']);
  git(['log', '--show-signature', '--oneline']);
  assert.equal(await exists(marker), true, 'fixture verifier is executable');
  await rm(marker);
  assert.match((await service.git('log')).text, /signed fixture/);
  assert.equal(await exists(marker), false, 'inspection must not invoke verifier');
});

for (const routed of [false, true]) test(`${routed ? 'Routed' : 'Direct'} reads reject a root replaced after path resolution`, async t => {
  const container = await makeTempDir(t, 'fusion-root-binding-');
  const root = join(container, 'approved'), outside = join(container, 'unapproved');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(root, 'note.txt'), 'approved\n');
  await writeFile(join(outside, 'note.txt'), 'PRIVATE_OUTSIDE_FIXTURE\n');
  const router = { async route(request: RouteRequest): Promise<RouteResult> {
    const candidate = request.candidates!.find(item => item.tool === 'read_file')!;
    return { decision: { status: 'selected', source: 'jev', candidateId: candidate.id,
      call: { tool: candidate.tool, arguments: candidate.arguments } }, usage: [], latencyMs: 0 };
  } };
  const service = new WorkspaceService(root, router);
  const original = (service as any).resolvePath.bind(service);
  let resolves = 0;
  // Insert a real junction/symlink at the precise asynchronous boundary while
  // retaining all production resolution, open, identity, and read operations.
  t.mock.method(service as any, 'resolvePath', async (path: string) => {
    const target = await original(path);
    if (++resolves === (routed ? 2 : 1)) {
      await rename(root, root + '-original');
      await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return target;
  });
  if (routed) {
    const result = await service.run({ task: 'Read note', path: 'note.txt' });
    assert.equal(result.execution?.status, 'failed');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OUTSIDE_FIXTURE/);
  } else {
    await assert.rejects(service.read('note.txt'), /workspace (?:root|path)/i);
  }
});

for (const location of ['.', 'bin']) test(`Fixed Git ignores a workspace executable in ${location} and unsafe PATH entries`, async t => {
  const { root, git, service } = await fixture(t);
  await writeFile(join(root, 'public.txt'), 'before\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  await writeFile(join(root, 'public.txt'), 'trusted-git-change\n');
  const shadow = join(root, location);
  await mkdir(shadow, { recursive: true });
  const fake = join(shadow, process.platform === 'win32' ? 'git.exe' : 'git');
  await copyFile(process.execPath, fake);
  const control = spawnSync(fake, ['-e', 'process.stdout.write("harmless-lookup-fixture")'], { encoding: 'utf8', windowsHide: true });
  assert.equal(control.status, 0);
  assert.equal(control.stdout, 'harmless-lookup-fixture', 'the repository executable can run if selected');
  const restoreEnv = setPathFirst([shadow, '.', ''], t);
  try {
    const diff = await service.git('diff');
    assert.match(diff.text, /\+trusted-git-change/);
    assert.equal(isAbsolute(diff.argv[0]!), true, 'receipt identifies the trusted executable actually launched');
    assert.ok(!diff.argv[0]!.startsWith(root), 'workspace executable is not trusted by an absolute PATH entry');
    assert.equal((await service.search('trusted-git-change')).ignoreRules, 'git');
  } finally {
    restoreEnv();
  }
});

for (const kind of ['root', 'nested', 'linked']) test(`Fixed Git binds ${kind} workspace scopes despite a redirected working tree`, async t => {
  const { root, git } = await fixture(t);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'parent.txt'), 'parent-before\n');
  await writeFile(join(root, 'nested/note.txt'), 'approved-before\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const outside = `${root}-outside`, linked = `${root}-linked`;
  await mkdir(outside); await mkdir(join(outside, 'nested'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'nested/note.txt'), 'PRIVATE_OUTSIDE_WORKTREE_FIXTURE\n');
  let workingTree = root;
  if (kind === 'linked') {
    git(['worktree', 'add', '--quiet', '-b', 'security-linked-fixture', linked]);
    t.after(() => rm(linked, { recursive: true, force: true }));
    workingTree = linked;
  }
  await writeFile(join(workingTree, 'nested/note.txt'), 'approved-worktree-change\n');
  await writeFile(join(workingTree, 'parent.txt'), 'parent-change\n');
  // Static repository configuration and inherited Git environment must not
  // move the approved filesystem boundary. A linked .git file stays supported.
  git(['config', 'core.worktree', outside]);
  const scopedRoot = kind === 'root' ? workingTree : join(workingTree, 'nested');
  const service = new WorkspaceService(scopedRoot, noProvider);
  const restoreEnv = setEnv({ GIT_WORK_TREE: outside, GIT_DIR: join(root, '.git') }, t);
  try {
    const diff = await service.git('diff');
    assert.doesNotMatch(diff.text, /PRIVATE_OUTSIDE_WORKTREE_FIXTURE/);
    assert.match(diff.text, /\+approved-worktree-change/);
    if (kind !== 'root') assert.doesNotMatch(diff.text, /parent-change/);
    assert.match((await service.git('status')).text, /note\.txt/);
    assert.match((await service.git('log')).text, /fixture/);
  } finally {
    restoreEnv();
  }
});

test('Fixed Git summarizes submodules without following an outside working tree for inline bytes', async t => {
  const { root, git, service } = await fixture(t);
  const outside = `${root}-submodule`;
  await mkdir(outside);
  t.after(() => rm(outside, { recursive: true, force: true }));
  const childGit = initGitRepo(outside);
  await writeFile(join(outside, 'note.txt'), 'submodule-before\n');
  childGit(['add', '.']); childGit(['commit', '-qm', 'submodule fixture']);
  const oid = childGit(['rev-parse', 'HEAD']);
  await writeFile(join(root, '.gitmodules'), '[submodule "sub"]\n path = sub\n url = ./fixture\n');
  git(['add', '.gitmodules']); git(['update-index', '--add', '--cacheinfo', `160000,${oid},sub`]);
  git(['commit', '-qm', 'parent fixture']);
  await symlink(outside, join(root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(outside, 'note.txt'), 'PRIVATE_OUTSIDE_SUBMODULE_FIXTURE\n');
  git(['config', 'diff.submodule', 'diff']);
  // Newer Git refuses a symlinked submodule path outright (exit 128), older Git follows it, and Windows
  // junctions are followed. The control only proves the fixture is hostile where Git still follows it.
  const controlRun = spawnSync('git', ['diff', '--submodule=diff'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (process.platform === 'win32') {
    assert.equal(controlRun.status, 0, controlRun.stderr);
    assert.match(controlRun.stdout, /PRIVATE_OUTSIDE_SUBMODULE_FIXTURE/, 'junction fixture permits inline Git traversal');
  }
  // Either the fixed Git summary succeeds or it is refused; no outside bytes may ever be returned.
  const outcome = await service.git('diff').then(value => ({ text: value.text }), (error: unknown) => ({ text: '', error: String((error as Error)?.message ?? error) }));
  assert.doesNotMatch(outcome.text + ('error' in outcome ? outcome.error : ''), /PRIVATE_OUTSIDE_SUBMODULE_FIXTURE/);
  if ('error' in outcome) assert.notEqual(process.platform, 'win32', 'Windows must still produce the submodule summary');
  else if (process.platform === 'win32') assert.match(outcome.text, /Subproject commit.*dirty/, 'submodule dirty summary remains visible');
});

for (const markerKind of ['file', 'junction']) test(`Fixed Git rejects a ${markerKind} marker pointing at unrelated private metadata`, async t => {
  const { root, git } = await fixture(t);
  await writeFile(join(root, 'note.txt'), 'PRIVATE_OUTSIDE_BASELINE_FIXTURE\n');
  git(['add', '.']); git(['commit', '-qm', 'private baseline fixture']);
  const approved = `${root}-approved`;
  await mkdir(approved);
  t.after(() => rm(approved, { recursive: true, force: true }));
  await writeFile(join(approved, 'note.txt'), 'approved-public-content\n');
  const marker = join(approved, '.git');
  if (markerKind === 'file') await writeFile(marker, `gitdir: ${join(root, '.git')}\n`);
  else await symlink(join(root, '.git'), marker, process.platform === 'win32' ? 'junction' : 'dir');
  const service = new WorkspaceService(approved, noProvider);
  await assert.rejects(service.git('diff'), /Git.*(?:metadata|unavailable)/i);
  await assert.rejects(service.git('log'), /Git.*(?:metadata|unavailable)/i);
});

test('Fixed Git rejects a tracked directory redirected outside the root', async t => {
  const { root, git, service } = await fixture(t);
  const outside = `${root}-directory`;
  await mkdir(outside); await mkdir(join(root, 'nested'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(root, 'nested/note.txt'), 'approved-before\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  await writeFile(join(outside, 'note.txt'), 'PRIVATE_OUTSIDE_DIRECTORY_FIXTURE\n');
  await rm(join(root, 'nested'), { recursive: true });
  await symlink(outside, join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.git('diff'), /Git.*(?:alias|scope|unavailable)/i);
});
