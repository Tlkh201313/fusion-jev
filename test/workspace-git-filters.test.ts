import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { runGitCommand } from '../src/workspace-git.js';
import { makeTempDir } from './helpers/tmp.js';
import { initGitRepo } from './helpers/git.js';
import { setEnv } from './helpers/env.js';

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function fixture(t: TestContext) {
  const root = await makeTempDir(t, 'fusion-filter-');
  const git = initGitRepo(root);
  await writeFile(join(root, 'public.txt'), 'before--public\n');
  git(['add', 'public.txt']);
  git(['commit', '-qm', 'fixture']);
  const marker = join(root, 'filter-ran');
  const script = join(root, '.git', 'filter.cjs');
  await writeFile(
    script,
    "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'filter-ran'), 'harmless'); process.stdin.pipe(process.stdout);\n",
  );
  const driver = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
  await writeFile(join(root, '.git', 'info', 'attributes'), 'public.txt filter=fixture.driver\n');
  await writeFile(join(root, 'public.txt'), 'changed-public\n');
  const later = new Date(Date.now() + 5000);
  await utimes(join(root, 'public.txt'), later, later);
  return { root, git, marker, driver };
}

const modes = [
  'local-clean',
  'local-process',
  'include',
  'includeIf',
  'worktree',
  'global-include',
  'command',
  'config-selector',
] as const;
for (const mode of modes) {
  for (const command of ['status', 'diff'] as const) {
    test(`Git ${command} disables filters from ${mode}`, async (t) => {
      const { root, git, marker, driver } = await fixture(t);
      const filterConfig = join(root, '.git', 'filters.config');
      const value = mode === 'local-process' ? 'process' : 'clean';
      await writeFile(
        filterConfig,
        `[filter "fixture.driver"]\n ${value} = ${JSON.stringify(driver)}\n smudge = ${JSON.stringify(driver)}\n required = true\n`,
      );
      if (mode === 'include') git(['config', 'include.path', filterConfig.replaceAll('\\', '/')]);
      else if (mode === 'includeIf')
        git([
          'config',
          `includeIf.gitdir/i:${root.replaceAll('\\', '/')}/.git.path`,
          filterConfig.replaceAll('\\', '/'),
        ]);
      else if (mode === 'worktree') {
        git(['config', 'extensions.worktreeConfig', 'true']);
        git(['config', '--worktree', `filter.fixture.driver.${value}`, driver]);
        git(['config', '--worktree', 'filter.fixture.driver.required', 'true']);
      } else if (mode === 'global-include') {
        const global = join(root, '.git', 'global.config');
        await writeFile(global, `[include]\n path = ${JSON.stringify(filterConfig.replaceAll('\\', '/'))}\n`);
        setEnv({ GIT_CONFIG_GLOBAL: global }, t);
      } else if (mode === 'command') {
        setEnv(
          {
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'filter.fixture.driver.clean',
            GIT_CONFIG_VALUE_0: driver,
            GIT_CONFIG_KEY_1: 'filter.fixture.driver.required',
            GIT_CONFIG_VALUE_1: 'true',
          },
          t,
        );
      } else {
        git(['config', `filter.fixture.driver.${value}`, driver]);
        git(['config', 'filter.fixture.driver.required', 'true']);
        if (mode === 'config-selector') {
          const decoy = join(root, '.git', 'decoy.config');
          await writeFile(decoy, '[core]\n bare = false\n');
          setEnv({ GIT_CONFIG: decoy }, t);
        }
      }
      const control = spawnSync('git', [command, '--ignore-submodules=none'], {
        cwd: root,
        windowsHide: true,
        encoding: 'utf8',
      });
      assert.equal(await exists(marker), true, `control must execute the harmless filter: ${control.stderr}`);
      await rm(marker);
      const { result } = await runGitCommand(root, command, new AbortController().signal);
      assert.equal(await exists(marker), false, `${command} must not execute a filter`);
      assert.match(result.text, command === 'diff' ? /\+changed-public/ : /public\.txt/);
      assert.equal(await readFile(join(root, 'public.txt'), 'utf8'), 'changed-public\n');
    });
  }
}

for (const command of ['status', 'diff'] as const) {
  test(`Git ${command} does not scan dirty submodule filters but retains commit changes`, async (t) => {
    const root = await makeTempDir(t, 'fusion-submodule-filter-');
    const git = initGitRepo(root);
    const child = join(root, 'sub');
    await mkdir(child);
    const childGit = initGitRepo(child);
    await writeFile(join(child, 'note.txt'), 'before\n');
    childGit(['add', 'note.txt']);
    childGit(['commit', '-qm', 'child baseline']);
    await writeFile(join(root, '.gitmodules'), '[submodule "sub"]\n path = sub\n url = ./sub\n ignore = none\n');
    git(['add', '.gitmodules']);
    git(['update-index', '--add', '--cacheinfo', `160000,${childGit(['rev-parse', 'HEAD'])},sub`]);
    git(['commit', '-qm', 'parent baseline']);
    const marker = join(child, 'filter-ran');
    const script = join(child, '.git', 'filter.cjs');
    await writeFile(
      script,
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'filter-ran'), 'harmless'); process.stdin.pipe(process.stdout);\n",
    );
    childGit([
      'config',
      'filter.child.clean',
      `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`,
    ]);
    await writeFile(join(child, '.git', 'info', 'attributes'), 'note.txt filter=child\n');
    await writeFile(join(child, 'note.txt'), 'dirty!\n');
    const later = new Date(Date.now() + 5000);
    await utimes(join(child, 'note.txt'), later, later);
    git(['config', 'diff.ignoreSubmodules', 'none']);
    git(['config', 'submodule.sub.ignore', 'none']);
    git(['config', 'status.submoduleSummary', 'true']);
    git([command, '--ignore-submodules=none']);
    assert.equal(await exists(marker), true, 'control must execute the child filter');
    await rm(marker);
    await runGitCommand(root, command, new AbortController().signal);
    assert.equal(await exists(marker), false, 'inspection must not scan dirty child contents');
    await writeFile(join(child, 'next.txt'), 'new child commit\n');
    childGit(['add', 'next.txt']);
    childGit(['commit', '-qm', 'child change']);
    await rm(marker, { force: true });
    const { result } = await runGitCommand(root, command, new AbortController().signal);
    assert.equal(await exists(marker), false, 'commit summaries must not scan dirty child contents');
    assert.match(result.text, command === 'diff' ? /Subproject commit/ : /sub/);
  });
}

for (const command of ['status', 'diff'] as const) {
  test(`Git ${command} disables an empty filter name`, async (t) => {
    const { root, git, marker, driver } = await fixture(t);
    git(['config', 'filter..clean', driver]);
    git(['config', 'filter..required', 'true']);
    await writeFile(join(root, '.git', 'info', 'attributes'), 'public.txt filter=\n');
    git([command]);
    assert.equal(await exists(marker), true, 'empty driver is selectable by Git');
    await rm(marker);
    await runGitCommand(root, command, new AbortController().signal);
    assert.equal(await exists(marker), false, 'inspection must disable the empty driver');
  });
}

test('Git inspection fails closed when filter configuration exceeds its bound', async (t) => {
  const { root, git, marker, driver } = await fixture(t);
  git(['config', 'filter.fixture.driver.clean', driver]);
  await appendFile(
    join(root, '.git', 'config'),
    Array.from({ length: 1500 }, (_, i) => `[filter "${i}-${'x'.repeat(40)}"]\n clean = ignored\n`).join(''),
  );
  for (const command of ['status', 'diff'] as const) {
    await assert.rejects(
      runGitCommand(root, command, new AbortController().signal),
      /configuration cannot be safely inspected/,
    );
    assert.equal(await exists(marker), false);
  }
});

test('Git inspection fails closed for a filter name that cannot be encoded with -c', async (t) => {
  const { root, git, marker, driver } = await fixture(t);
  git(['config', 'filter.fixture=driver.clean', driver]);
  await writeFile(join(root, '.git', 'info', 'attributes'), 'public.txt filter=fixture=driver\n');
  git(['diff']);
  assert.equal(await exists(marker), true, 'equals is a valid filter subsection name');
  await rm(marker);
  for (const command of ['status', 'diff'] as const) {
    await assert.rejects(
      runGitCommand(root, command, new AbortController().signal),
      /configuration cannot be safely inspected/,
    );
    assert.equal(await exists(marker), false);
  }
});

test('Git revalidates its root after filter configuration inspection', async (t) => {
  const { root } = await fixture(t);
  const outside = await makeTempDir(t, 'fusion-filter-outside-');
  initGitRepo(outside);
  const originalRoot = root + '-original';
  t.after(() => rm(originalRoot, { recursive: true, force: true }));
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file: string, args: string[], options: any) => {
    const child = originalSpawn(file, args, options);
    if (args.includes('--show-scope')) {
      child.once('close', () => {
        renameSync(root, originalRoot);
        symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
      });
    }
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(runGitCommand(root, 'status', new AbortController().signal), /Workspace root changed/);
});
