import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { runGitCommand } from '../src/workspace-git.js';
import { makeTempDir } from './helpers/tmp.js';
import { initGitRepo } from './helpers/git.js';

function delayedConfig(t: TestContext, script = 'setTimeout(()=>process.exit(1),1000)') {
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const children: ChildProcess[] = [];
  const closedChildren = new Set<ChildProcess>();
  const inspections: string[] = [];
  // Intercept both APIs so the regression exercises the synchronous version
  // before the fix and the asynchronous version afterward. Only config is slow.
  t.mock.method(childProcess, 'spawnSync', (file: string, args: string[], options: any) =>
    args.includes('--show-scope')
      ? originalSpawnSync(process.execPath, ['-e', script], options)
      : originalSpawnSync(file, args, options),
  );
  t.mock.method(childProcess, 'spawn', (file: string, args: string[], options: any) => {
    if (!args.includes('--show-scope')) {
      if (args.includes('status') || args.includes('diff')) inspections.push(args.join(' '));
      return originalSpawn(file, args, options);
    }
    const child = originalSpawn(process.execPath, ['-e', script], options);
    children.push(child);
    child.once('close', () => closedChildren.add(child));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { children, closedChildren, inspections };
}

async function closed(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
}

for (const command of ['status', 'diff'] as const) {
  for (const mode of ['cancel', 'deadline'] as const) {
    test(`Git ${command} ${mode} stays responsive during filter config lookup`, async (t) => {
      const root = await makeTempDir(t, 'fusion-filter-cancel-');
      initGitRepo(root);
      const { children, closedChildren, inspections } = delayedConfig(t);
      const controller = new AbortController();
      const signal = mode === 'deadline' ? AbortSignal.timeout(20) : controller.signal;
      const started = performance.now();
      let abortedAt = 0;
      signal.addEventListener('abort', () => (abortedAt = performance.now() - started), { once: true });
      const cancel = mode === 'cancel' ? setTimeout(() => controller.abort(), 20) : undefined;
      const heartbeat = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 40));
      try {
        await assert.rejects(runGitCommand(root, command, signal, { staged: command === 'diff' }), {
          code: mode === 'cancel' ? 'CANCELLED' : 'TIMEOUT',
        });
        assert.ok(abortedAt < 300, `abort timer was blocked for ${abortedAt}ms`);
        const heartbeatAt = await heartbeat;
        assert.ok(heartbeatAt < 300, '40ms heartbeat was blocked by the config subprocess');
        assert.deepEqual(inspections, [], 'cancelled lookup must not launch status/diff');
        assert.equal(children.length, 1);
        assert.ok(closedChildren.has(children[0]!), 'lookup must close before the request settles');
        await closed(children[0]!);
        assert.equal(children[0]!.killed, true, 'lookup subprocess must be killed');
        assert.equal(getEventListeners(signal, 'abort').length, 0, 'lookup abort listener must be removed');
        t.diagnostic(`abort=${abortedAt.toFixed(1)}ms; heartbeat=${heartbeatAt.toFixed(1)}ms; config child killed`);
      } finally {
        if (cancel) clearTimeout(cancel);
        await heartbeat;
      }
    });
  }
}

test('Git filter config lookup enforces its own deadline and cleans up', async (t) => {
  const root = await makeTempDir(t, 'fusion-filter-deadline-');
  initGitRepo(root);
  const { children, closedChildren, inspections } = delayedConfig(t, 'setInterval(()=>{},1000)');
  const signal = new AbortController().signal;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(runGitCommand(root, 'status', signal), {
    code: 'GIT_FAILED',
    message: 'Git configuration cannot be safely inspected',
  });
  assert.equal(children.length, 1);
  t.mock.timers.tick(5000);
  await rejected;
  assert.ok(closedChildren.has(children[0]!));
  await closed(children[0]!);
  assert.equal(children[0]!.killed, true);
  assert.deepEqual(inspections, []);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('Git filter config lookup bounds discarded stderr and cleans up', async (t) => {
  const root = await makeTempDir(t, 'fusion-filter-stderr-');
  initGitRepo(root);
  const { children, closedChildren, inspections } = delayedConfig(
    t,
    'process.stderr.write("x".repeat(32769));setInterval(()=>{},1000)',
  );
  const signal = new AbortController().signal;
  await assert.rejects(runGitCommand(root, 'status', signal), {
    code: 'GIT_FAILED',
    message: 'Git configuration cannot be safely inspected',
  });
  assert.ok(closedChildren.has(children[0]!));
  await closed(children[0]!);
  assert.equal(children[0]!.killed, true);
  assert.deepEqual(inspections, []);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});
