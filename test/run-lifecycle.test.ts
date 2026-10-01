import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvidenceStore, type EvidenceCapture } from '../src/evidence.js';
import { runCommand } from '../src/run.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cliArgs = (...args: string[]) => ['--import', import.meta.resolve('tsx'), cli, ...args];
const posix = process.platform !== 'win32';

async function waitFor(path: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try { await access(path); return; } catch { /* not yet */ }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('a background descendant holding the pipes does not hang a plain run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-run-pipes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidPath = join(dir, 'descendant.pid');
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit',detached:true});`
    + `require('node:fs').writeFileSync(process.argv[1],String(c.pid));c.unref();console.log('parent done');process.exit(3)`;
  let descendant: number | undefined;
  try {
    const started = performance.now();
    const result = await runCommand({ argv: [process.execPath, '-e', script, pidPath] }, new EvidenceStore());
    descendant = Number(await readFile(pidPath, 'utf8'));
    assert.ok(performance.now() - started < 10_000, 'run must settle shortly after the direct child exits');
    assert.equal(result.termination, 'exit');
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout.originalBytes, null, 'output after detaching from held pipes is marked incomplete');
  } finally {
    if (descendant) try { process.kill(descendant, 'SIGKILL'); } catch { /* already exited */ }
  }
});

test('cancellation forwards the received signal before forcing a kill', { skip: !posix }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-run-signal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ready = join(dir, 'ready');
  const cleaned = join(dir, 'cleaned');
  const script = `const fs=require('node:fs');process.on('SIGINT',()=>{fs.writeFileSync(process.argv[2],'SIGINT');process.exit(0)});`
    + `fs.writeFileSync(process.argv[1],'x');setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const running = runCommand({ argv: [process.execPath, '-e', script, ready, cleaned] }, new EvidenceStore(), controller.signal);
  await waitFor(ready);
  controller.abort('SIGINT');
  const result = await running;
  assert.equal(result.termination, 'cancelled');
  assert.equal(await readFile(cleaned, 'utf8'), 'SIGINT', 'the command received SIGINT and could clean up');
});

test('evidence storage failure keeps the child exit status', async () => {
  class FailingStore extends EvidenceStore {
    override capture(_input: EvidenceCapture): never { throw new Error('ENOSPC: no space left on device'); }
  }
  const result = await runCommand({ argv: [process.execPath, '-e', 'console.log("out");process.exitCode=5'] }, new FailingStore());
  assert.equal(result.termination, 'exit');
  assert.equal(result.exitCode, 5);
  assert.equal(result.evidenceUnavailable, true);
  const page = await result.evidence!.expand({ id: result.stdout.id });
  assert.equal(page.status, 'ok');
});

test('raw output into a closed reader keeps the child status', { skip: !posix }, () => {
  const command = [process.execPath, ...cliArgs('run', '--raw', '--', process.execPath, '-e',
    'for(let i=0;i<20000;i++)console.log("line "+i);process.exitCode=4')].map(arg => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
  const result = spawnSync('bash', ['-c', `${command} | head -1; echo "status=\${PIPESTATUS[0]}"`], { encoding: 'utf8' });
  assert.match(result.stdout, /^line 0\n/);
  assert.match(result.stdout, /status=4\n/, result.stderr);
  assert.doesNotMatch(result.stderr, /EPIPE|Unhandled|uncaught/i);
});

test('signal deaths map to 128 plus the signal number', { skip: !posix }, () => {
  const result = spawnSync(process.execPath, cliArgs('run', '--raw', '--', process.execPath, '-e', 'process.kill(process.pid,"SIGTERM")'), { encoding: 'utf8' });
  assert.equal(result.status, 143, result.stderr);
});

test('empty XDG cache variable falls back to the default cache', { skip: !posix }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'fusion-run-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, cliArgs('run', '--', process.execPath, '-e', 'console.log("ok")'),
    { encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CACHE_HOME: '' } });
  assert.equal(result.status, 0, result.stderr);
  await access(join(home, '.cache', 'fusion-jev-mcp', 'evidence'));
});
