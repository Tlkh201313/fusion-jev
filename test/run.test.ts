import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { makeTempDir } from './helpers/tmp.js';
import { waitFor } from './helpers/wait.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EvidenceStore } from '../src/evidence.js';
import { runCommand, terminateWindowsTree } from '../src/run.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const rawDrainFixture = fileURLToPath(new URL('./fixtures/raw-drain.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const cliArgs = (...args: string[]) => ['--import', tsxImport, cli, ...args];
const badProvider = { ...process.env, FUSION_FALLBACK: 'gpt', FUSION_ENV_FILE: join(tmpdir(), 'missing-fusion-provider.env'), TYPESAFE_API_KEY: '' };

async function withDeadline<T>(pending: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(() => readFile(path).then(() => true, () => false), 2000, 20, `fixture to create ${path}`);
}

interface WindowsProcessIdentity { pid: number; startTicks: string }

function windowsStartTicks(pid: number): string | undefined {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const script = `$ErrorActionPreference='Stop';try{$p=[System.Diagnostics.Process]::GetProcessById(${pid});if($p.HasExited){exit 0};[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString())}catch [System.ArgumentException]{exit 0}catch [System.InvalidOperationException]{exit 0}catch{[Console]::Error.Write($_);exit 2}finally{if($p){$p.Dispose()}}`;
  const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(query.status, 0, query.stderr);
  const ticks = query.stdout.trim();
  if (ticks) assert.match(ticks, /^[1-9]\d{0,19}$/);
  return ticks || undefined;
}

function recordWindowsProcess(pid: number): WindowsProcessIdentity {
  const startTicks = windowsStartTicks(pid);
  assert.ok(startTicks, `process ${pid} exited before its identity was recorded`);
  return { pid, startTicks };
}

test('runner preserves argv and keeps stdout and stderr as separate exact receipts', async () => {
  const evidence = new EvidenceStore();
  const argv = [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("warn\\n"); process.exitCode=7', 'a b', 'a"b', '--', '雪'] as [string, ...string[]];
  const result = await runCommand({ argv }, evidence);
  assert.equal(result.termination, 'exit'); assert.equal(result.exitCode, 7);
  assert.equal(result.stdout.source.kind, 'command'); assert.equal(result.stderr.source.kind, 'command');
  assert.equal(result.stdout.source.kind === 'command' && result.stdout.source.channel, 'stdout');
  assert.equal(result.stderr.source.kind === 'command' && result.stderr.source.channel, 'stderr');
  const out = await evidence.expand({ id: result.stdout.id });
  const err = await evidence.expand({ id: result.stderr.id });
  assert.equal(out.status, 'ok'); assert.equal(err.status, 'ok');
  if (out.status === 'ok' && err.status === 'ok') {
    assert.deepEqual(JSON.parse(Buffer.from(out.dataBase64, 'base64').toString()), ['a b', 'a"b', '--', '雪']);
    assert.equal(Buffer.from(err.dataBase64, 'base64').toString(), 'warn\n');
  }
});

test('runner caps output while counting original bytes', async () => {
  const evidence = new EvidenceStore();
  const result = await runCommand({ argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(4096))'], maxCaptureBytes: 17 }, evidence);
  assert.equal(result.stdout.storedBytes, 17); assert.equal(result.stdout.originalBytes, 4096);
  assert.equal(result.stdout.truncated, true);
});

test('runner launches a failing child exactly once', async t => {
  const dir = await makeTempDir(t, 'fusion-run-once-');
  const marker = join(dir, 'launches.txt');
  const script = 'require("node:fs").appendFileSync(process.argv[1],"x");process.exit(5)';
  const result = await runCommand({ argv: [process.execPath, '-e', script, marker] }, new EvidenceStore());
  assert.equal(result.exitCode, 5);
  assert.equal(await readFile(marker, 'utf8'), 'x');
});

test('failed spawn is categorized without a fabricated exit code', async () => {
  const result = await runCommand({ argv: ['fusion-no-such-executable-929490'] }, new EvidenceStore());
  assert.equal(result.termination, 'spawn_error'); assert.equal(result.exitCode, null);
  assert.equal(result.errorCode, 'not_found');
});

test('timeout and cancellation stop child process trees', async t => {
  const dir = await makeTempDir(t, 'fusion-run-tree-');
  for (const mode of ['timeout', 'cancel'] as const) {
    const pidPath = join(dir, mode + '.pid');
    const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000)`;
    const controller = new AbortController();
    const evidence = new EvidenceStore();
    const running = runCommand({ argv: [process.execPath, '-e', script, pidPath], timeoutMs: mode === 'timeout' ? 2500 : 10000 }, evidence, controller.signal);
    let descendantPid: number | undefined;
    let descendantIdentity: WindowsProcessIdentity | undefined;
    try {
      await waitForFile(pidPath);
      descendantPid = Number(await readFile(pidPath, 'utf8'));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      if (process.platform === 'win32') descendantIdentity = recordWindowsProcess(descendantPid);
      if (mode === 'cancel') controller.abort();
      const result = await running;
      const stderr = await evidence.expand({ id: result.stderr.id });
      assert.equal(result.termination, mode === 'timeout' ? 'timeout' : 'cancelled',
        stderr.status === 'ok' ? Buffer.from(stderr.dataBase64, 'base64').toString() : stderr.status);
      if (descendantIdentity) {
        assert.notEqual(windowsStartTicks(descendantIdentity.pid), descendantIdentity.startTicks,
          `${mode} descendant ${descendantPid} survived; cleanupFailed=${result.cleanupFailed}`);
      } else {
        const query = spawnSync('ps', ['-p', String(descendantPid), '-o', 'stat='], { encoding: 'utf8' });
        assert.ok(query.status === 0 || query.status === 1, query.stderr);
        assert.ok(!query.stdout.trim() || /^Z/.test(query.stdout.trim()), `${mode} descendant ${descendantPid} survived; cleanupFailed=${result.cleanupFailed}`);
      }
    } finally {
      controller.abort();
      if (descendantIdentity) await terminateWindowsTree([descendantIdentity]);
      else if (descendantPid && process.platform !== 'win32') {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
  }
});

test('CLI run bypasses invalid provider settings, emits compact receipts, and expands them after exit', () => {
  // Output above the verbatim limit is persisted; tiny complete output is printed without receipts.
  const run = spawnSync(process.execPath, cliArgs('run', '--', process.execPath, '-e', 'process.stdout.write("hello".repeat(300));process.stderr.write("oops")'), { encoding: 'utf8', env: badProvider });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /termination=exit/);
  const outId = /stdout=([0-9a-f-]{36})/.exec(run.stdout)?.[1];
  const errId = /stderr=([0-9a-f-]{36})/.exec(run.stdout)?.[1];
  assert.ok(outId); assert.ok(errId);
  const out = spawnSync(process.execPath, cliArgs('evidence', outId), { encoding: 'utf8', env: badProvider });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(Buffer.from(JSON.parse(out.stdout).dataBase64, 'base64').toString(), 'hello'.repeat(300));
  const err = spawnSync(process.execPath, cliArgs('evidence', errId, '--raw'), { env: badProvider });
  assert.equal(err.status, 0, err.stderr.toString()); assert.deepEqual(err.stdout, Buffer.from('oops'));
});

test('compact CLI run reports per-channel truncation and known-secret redaction', () => {
  const capped = spawnSync(process.execPath, cliArgs('run', '--max-capture-bytes=1', '--', process.execPath, '-e',
    'process.stdout.write("1234");process.stderr.write("warn")'), { encoding: 'utf8', env: badProvider });
  assert.equal(capped.status, 0, capped.stderr);
  assert.match(capped.stdout, /stdoutStoredBytes=1 stdoutOriginalBytes=4 stdoutTruncated=true stderr=/);
  assert.match(capped.stdout, /stderrStoredBytes=1 stderrOriginalBytes=4 stderrTruncated=true\n/);
  assert.doesNotMatch(capped.stdout, /Redacted/);
  const redacted = spawnSync(process.execPath, cliArgs('run', '--', process.execPath, '-e',
    'process.stdout.write("TYPESAFE_API_KEY=topsecret\\n");process.stderr.write("ok")'), { encoding: 'utf8', env: badProvider });
  assert.equal(redacted.status, 0, redacted.stderr);
  assert.match(redacted.stdout, /stdoutStoredBytes=\d+ stdoutOriginalBytes=\d+ stdoutRedacted=true stderr=/);
  assert.match(redacted.stdout, /stderrStoredBytes=2\n/);
  assert.doesNotMatch(redacted.stdout, /Truncated/);
  assert.doesNotMatch(redacted.stdout, /topsecret/);
});

test('CLI raw output preserves binary channels and child exit code', () => {
  const run = spawnSync(process.execPath, cliArgs('run', '--raw', '--', process.execPath, '-e', 'process.stdout.write(Buffer.from([0,255,10]));process.stderr.write(Buffer.from([128,13]));process.exitCode=9'), { env: badProvider });
  assert.equal(run.status, 9); assert.deepEqual(run.stdout, Buffer.from([0,255,10])); assert.deepEqual(run.stderr, Buffer.from([128,13]));
});

test('raw relay waits for slow stdout drain without unbounded queued writes', () => {
  const run = spawnSync(process.execPath, ['--import', tsxImport, rawDrainFixture], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stderr);
  assert.equal(result.exitCode, 0);
  assert.equal(result.storedBytes, 1024);
  assert.equal(result.originalBytes, 1024 * 1024);
  assert.equal(result.queuedAtReturn, 0);
  assert.ok(result.peakQueued <= 128 * 1024, `peak queued relay bytes ${result.peakQueued}`);
  assert.equal(result.byteLength, 1024 * 1024);
  assert.equal(result.sha256, createHash('sha256').update(Buffer.alloc(1024 * 1024, 0x5a)).digest('hex'));
});

test('CLI preserves every argument after separator, including Fusion-looking options', () => {
  const args = ['a b', 'a"b', '--', '雪', '--env-file=literal', 'x&y'];
  const run = spawnSync(process.execPath, cliArgs('run', '--raw', '--', process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args), { env: badProvider });
  assert.equal(run.status, 0, run.stderr.toString());
  assert.deepEqual(JSON.parse(run.stdout.toString()), args);
});

test('CLI maps an absent executable to exit 127 without leaking its environment', () => {
  const run = spawnSync(process.execPath, cliArgs('run', '--', 'fusion-no-such-executable-929490'), { encoding: 'utf8', env: badProvider });
  assert.equal(run.status, 127, run.stderr);
  assert.match(run.stdout, /termination=spawn_error exitCode=null/);
});

test('CLI rejects invalid Fusion options and missing separator without launching', async t => {
  const dir = await makeTempDir(t, 'fusion-run-validation-');
  const marker = join(dir, 'launched');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`;
  for (const options of [['--unknown'], ['--timeout-ms=-1'], ['--cwd=.'], []]) {
    const args = options.length ? ['run', ...options, '--', process.execPath, '-e', script] : ['run', process.execPath, '-e', script];
    const result = spawnSync(process.execPath, cliArgs(...args), { encoding: 'utf8', env: badProvider });
    assert.equal(result.status, 1, args.join(' '));
  }
  await assert.rejects(readFile(marker));
});

test('Windows cmd launcher with spaced path receives quoted and metacharacter arguments', { skip: process.platform !== 'win32' }, async t => {
  const dir = await makeTempDir(t, 'fusion cmd fixture ');
  const shimDir = join(dir, 'node_modules', '.bin');
  await mkdir(shimDir, { recursive: true });
  const shim = join(shimDir, 'argv fixture.cmd');
  await writeFile(join(dir, 'args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  await writeFile(shim, `@echo off\r\nnode "${join(dir, 'args.js')}" %*\r\n`);
  const args = ['a b', 'a"b', 'x&y', 'q|r', 'x^y', 'a(b)', '%COMSPEC%', '雪'];
  const evidence = new EvidenceStore();
  const result = await runCommand({ argv: [shim, ...args] }, evidence);
  const stdout = await evidence.expand({ id: result.stdout.id });
  const stderr = await evidence.expand({ id: result.stderr.id });
  assert.equal(result.termination, 'exit');
  assert.equal(result.exitCode, 0, stderr.status === 'ok' ? Buffer.from(stderr.dataBase64, 'base64').toString() : '');
  assert.equal(stdout.status, 'ok');
  if (stdout.status === 'ok') assert.deepEqual(JSON.parse(Buffer.from(stdout.dataBase64, 'base64').toString()), args);
  const ordinary = join(dir, 'ordinary fixture.cmd');
  await writeFile(ordinary, `@echo off\r\nnode "${join(dir, 'args.js')}" %*\r\n`);
  const ordinaryEvidence = new EvidenceStore();
  const ordinaryResult = await runCommand({ argv: [ordinary, ...args] }, ordinaryEvidence);
  const ordinaryOut = await ordinaryEvidence.expand({ id: ordinaryResult.stdout.id });
  assert.equal(ordinaryResult.exitCode, 0);
  assert.equal(ordinaryOut.status, 'ok');
  if (ordinaryOut.status === 'ok') assert.deepEqual(JSON.parse(Buffer.from(ordinaryOut.dataBase64, 'base64').toString()), args);
});

test('Windows timeout kills pipe-holding descendant after its direct parent exits', { skip: process.platform !== 'win32' }, async t => {
  const dir = await makeTempDir(t, 'fusion-run-orphan-');
  const pidPath = join(dir, 'descendant.pid');
  const marker = join(dir, 'survived.txt');
  const parentExitPath = join(dir, 'parent-exited.txt');
  const parentPidPath = join(dir, 'parent.pid');
  const descendant = 'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"survived"),8000);setInterval(()=>{},1000)';
  const parent = `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[2]],{stdio:['ignore','inherit','inherit'],detached:true});fs.writeFileSync(process.argv[1],String(child.pid));fs.writeFileSync(process.argv[4],String(process.pid));child.unref();setTimeout(()=>fs.writeFileSync(process.argv[3],'exited'),2500)`;
  let descendantIdentity: WindowsProcessIdentity | undefined;
  try {
    const started = performance.now();
    const running = runCommand({ argv: [process.execPath, '-e', parent, pidPath, marker, parentExitPath, parentPidPath], timeoutMs: 4500 }, new EvidenceStore());
    await waitForFile(pidPath);
    await waitForFile(parentPidPath);
    descendantIdentity = recordWindowsProcess(Number(await readFile(pidPath, 'utf8')));
    const parentIdentity = recordWindowsProcess(Number(await readFile(parentPidPath, 'utf8')));
    await waitForFile(parentExitPath);
    assert.equal(await readFile(parentExitPath, 'utf8'), 'exited');
    while (windowsStartTicks(parentIdentity.pid) === parentIdentity.startTicks && performance.now() - started < 4500) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.notEqual(windowsStartTicks(parentIdentity.pid), parentIdentity.startTicks, 'parent remained alive until runner timeout');
    assert.ok(performance.now() - started < 4500, 'parent exit was not observed before runner timeout');
    assert.equal(windowsStartTicks(descendantIdentity.pid), descendantIdentity.startTicks,
      'recorded descendant was not alive after its parent exited');
    const result = await withDeadline(running, 11000, 'runner hung after parent exited');
    assert.equal(result.termination, 'timeout');
    assert.equal(result.cleanupFailed, true, 'root exit makes discovery after its final snapshot uncertain');
    assert.notEqual(windowsStartTicks(descendantIdentity.pid), descendantIdentity.startTicks, 'recorded descendant still alive');
    await assert.rejects(readFile(marker));
  } finally {
    if (descendantIdentity) await terminateWindowsTree([descendantIdentity]);
  }
});

test('Windows cleanup failure returns bounded incomplete receipts instead of hanging', { skip: process.platform !== 'win32' }, async t => {
  const dir = await makeTempDir(t, 'fusion-run-cleanup-failure-');
  const pidPath = join(dir, 'child.pid');
  const originalSystemRoot = process.env.SystemRoot;
  let childPid: number | undefined;
  const parent = 'const fs=require("node:fs");const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"],detached:true});fs.writeFileSync(process.argv[1],String(child.pid));child.unref()';
  try {
    const running = runCommand({ argv: [process.execPath, '-e', parent, pidPath], timeoutMs: 500 }, new EvidenceStore());
    await waitForFile(pidPath);
    process.env.SystemRoot = join(dir, 'missing-windows-directory');
    const result = await withDeadline(
      running,
      6500, 'cleanup failure hung the runner');
    assert.equal(result.termination, 'timeout');
    assert.equal(result.cleanupFailed, true);
    assert.equal(result.stdout.truncated, true);
    assert.equal(result.stdout.originalBytes, null);
  } finally {
    process.env.SystemRoot = originalSystemRoot;
    try { childPid = Number(await readFile(pidPath, 'utf8')); } catch { /* Child did not start. */ }
    if (childPid) spawnSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore' });
  }
});

test('Windows rapid parent exit without a proven identity fails closed', { skip: process.platform !== 'win32' }, async t => {
  const dir = await makeTempDir(t, 'fusion-run-unproven-root-');
  const pidPath = join(dir, 'descendant.pid');
  const parent = 'const fs=require("node:fs");const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"],detached:true});fs.writeFileSync(process.argv[1],String(child.pid));child.unref()';
  let descendantPid: number | undefined;
  try {
    const result = await withDeadline(runCommand({ argv: [process.execPath, '-e', parent, pidPath], timeoutMs: 250 }, new EvidenceStore()),
      6500, 'unproven root cleanup hung');
    assert.equal(result.termination, 'timeout');
    assert.equal(result.cleanupFailed, true);
    assert.equal(result.stdout.truncated, true);
    assert.equal(result.stdout.originalBytes, null);
  } finally {
    try { descendantPid = Number(await readFile(pidPath, 'utf8')); } catch { /* Child may not have launched. */ }
    if (descendantPid) spawnSync('taskkill', ['/PID', String(descendantPid), '/T', '/F'], { stdio: 'ignore' });
  }
});

test('Windows exit observed during first snapshot discards identity before cleanup', { skip: process.platform !== 'win32' }, async () => {
  const module = await import('../src/run.js') as unknown as {
    captureWindowsIdentity?: (snapshot: () => Promise<Array<{ pid: number; startTicks: string }> | undefined>, live: () => boolean) => Promise<Array<{ pid: number; startTicks: string }> | undefined>;
    cleanupWindowsTree?: (rootPid: number, initial: Promise<Array<{ pid: number; startTicks: string }> | undefined>, exited: () => boolean,
      snapshot: (pid: number) => Promise<Array<{ pid: number; startTicks: string }> | undefined>,
      terminate: (records: Array<{ pid: number; startTicks: string }>) => Promise<boolean>) => Promise<boolean>;
  };
  assert.equal(typeof module.captureWindowsIdentity, 'function');
  assert.equal(typeof module.cleanupWindowsTree, 'function');
  let exitObserved = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let snapshotCalls = 0;
  let terminateCalls = 0;
  const initial = module.captureWindowsIdentity!(async () => {
    snapshotCalls++;
    await gate;
    return [{ pid: 42, startTicks: '123' }];
  }, () => !exitObserved);
  exitObserved = true;
  release();
  assert.equal(await module.cleanupWindowsTree!(42, initial, () => exitObserved,
    async () => { snapshotCalls++; return [{ pid: 42, startTicks: '456' }]; },
    async () => { terminateCalls++; return true; }), false);
  assert.equal(snapshotCalls, 1);
  assert.equal(terminateCalls, 0);
});

test('Windows exit observed before first snapshot never starts PID discovery', { skip: process.platform !== 'win32' }, async () => {
  const module = await import('../src/run.js') as unknown as {
    captureWindowsIdentity: (snapshot: () => Promise<Array<{ pid: number; startTicks: string }> | undefined>, live: () => boolean) => Promise<Array<{ pid: number; startTicks: string }> | undefined>;
    cleanupWindowsTree: (rootPid: number, initial: Promise<Array<{ pid: number; startTicks: string }> | undefined>, live: () => boolean,
      snapshot: (pid: number) => Promise<Array<{ pid: number; startTicks: string }> | undefined>,
      terminate: (records: Array<{ pid: number; startTicks: string }>) => Promise<boolean>) => Promise<boolean>;
  };
  let snapshots = 0;
  let terminations = 0;
  const live = () => false;
  const initial = module.captureWindowsIdentity(async () => { snapshots++; return [{ pid: 42, startTicks: '123' }]; }, live);
  assert.equal(await module.cleanupWindowsTree(42, initial, live,
    async () => { snapshots++; return [{ pid: 42, startTicks: '456' }]; },
    async () => { terminations++; return true; }), false);
  assert.equal(snapshots, 0);
  assert.equal(terminations, 0);
});

test('Windows cleanup reports success when root exits during verified termination', { skip: process.platform !== 'win32' }, async () => {
  const module = await import('../src/run.js') as unknown as {
    cleanupWindowsTree: (rootPid: number, initial: Promise<Array<{ pid: number; startTicks: string }> | undefined>, live: () => boolean,
      snapshot: (pid: number) => Promise<Array<{ pid: number; startTicks: string }> | undefined>,
      terminate: (records: Array<{ pid: number; startTicks: string }>) => Promise<boolean>) => Promise<boolean>;
  };
  const identities = [{ pid: 42, startTicks: '123' }, { pid: 43, startTicks: '456' }];
  let exitObserved = false;
  const cleaned = await module.cleanupWindowsTree(42, Promise.resolve(identities), () => !exitObserved,
    async () => identities,
    async records => {
      assert.deepEqual(records, identities);
      exitObserved = true;
      return true;
    });
  assert.equal(cleaned, true);
});

test('Windows root trust uses public ChildProcess lifecycle without a private handle', { skip: process.platform !== 'win32' }, async () => {
  const module = await import('../src/run.js') as unknown as {
    canTrustWindowsRoot: (child: Pick<ReturnType<typeof spawn>, 'exitCode' | 'signalCode'>, exitObserved: boolean) => boolean;
  };
  const child = { exitCode: null, signalCode: null };
  assert.equal(module.canTrustWindowsRoot(child, false), true);
  assert.equal(module.canTrustWindowsRoot(child, true), false);
  assert.equal(module.canTrustWindowsRoot({ ...child, exitCode: 0 }, false), false);
});

test('Windows cleanup refuses a reused PID with a different creation identity', { skip: process.platform !== 'win32' }, async t => {
  const dir = await makeTempDir(t, 'fusion-run-pid-reuse-');
  const marker = join(dir, 'unrelated-survived.txt');
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"alive"),500);setInterval(()=>{},1000)', marker], { stdio: 'ignore' });
  try {
    const module = await import('../src/run.js') as unknown as { terminateWindowsTree?: (identities: Array<{ pid: number; startTicks: string }>) => Promise<boolean> };
    assert.equal(typeof module.terminateWindowsTree, 'function');
    const killed = await module.terminateWindowsTree!([{ pid: unrelated.pid!, startTicks: '0' }]);
    assert.equal(killed, false);
    // The unrelated process writes its marker after ~500 ms only if it survived; wait for that event instead of a fixed sleep.
    await waitFor(async () => readFile(marker, 'utf8').then(text => text === 'alive', () => false), 15000, 20, 'unrelated process to write its survival marker');
    assert.equal(await readFile(marker, 'utf8'), 'alive');
  } finally {
    if (unrelated.pid) spawnSync('taskkill', ['/PID', String(unrelated.pid), '/T', '/F'], { stdio: 'ignore' });
  }
});

test('Windows snapshot records an exact identity while the root is alive', { skip: process.platform !== 'win32' }, async () => {
  const module = await import('../src/run.js') as unknown as { snapshotWindowsTree: (pid: number) => Promise<Array<{ pid: number; startTicks: string }> | undefined> };
  const identities = await module.snapshotWindowsTree(process.pid);
  assert.ok(identities);
  assert.ok(identities.some(item => item.pid === process.pid && /^[1-9]\d+$/.test(item.startTicks)));
});

test('Windows snapshot records descendant identity under a live root', { skip: process.platform !== 'win32' }, async t => {
  const dir = await makeTempDir(t, 'fusion-run-tree-snapshot-');
  const pidPath = join(dir, 'descendant.pid');
  const script = 'const fs=require("node:fs");const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",detached:true});fs.writeFileSync(process.argv[1],String(child.pid));child.unref();setInterval(()=>{},1000)';
  const parent = spawn(process.execPath, ['-e', script, pidPath], { stdio: 'ignore' });
  let childPid: number | undefined;
  try {
    await waitForFile(pidPath);
    childPid = Number(await readFile(pidPath, 'utf8'));
    const module = await import('../src/run.js') as unknown as { snapshotWindowsTree: (pid: number) => Promise<Array<{ pid: number; startTicks: string }> | undefined> };
    const identities = await module.snapshotWindowsTree(parent.pid!);
    assert.ok(identities?.some(item => item.pid === parent.pid));
    assert.ok(identities?.some(item => item.pid === childPid), `missing descendant ${childPid}: ${JSON.stringify(identities)}`);
  } finally {
    if (parent.pid) spawnSync('taskkill', ['/PID', String(parent.pid), '/T', '/F'], { stdio: 'ignore' });
    if (childPid) spawnSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore' });
  }
});

test('Windows cleanup terminates a process with the recorded creation identity', { skip: process.platform !== 'win32' }, async () => {
  const target = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const module = await import('../src/run.js') as unknown as {
      snapshotWindowsTree: (pid: number) => Promise<Array<{ pid: number; startTicks: string }> | undefined>;
      terminateWindowsTree: (identities: Array<{ pid: number; startTicks: string }>) => Promise<boolean>;
    };
    const identities = await module.snapshotWindowsTree(target.pid!);
    assert.ok(identities?.some(item => item.pid === target.pid));
    assert.equal(await module.terminateWindowsTree(identities!), true);
    const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${target.pid} -ErrorAction SilentlyContinue`], { encoding: 'utf8' });
    assert.equal(query.stdout.trim(), '');
  } finally {
    if (target.pid) spawnSync('taskkill', ['/PID', String(target.pid), '/T', '/F'], { stdio: 'ignore' });
  }
});

test('Windows cleanup terminates every recorded identity in a tree', { skip: process.platform !== 'win32' }, async () => {
  const targets = [spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }),
    spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })];
  try {
    const module = await import('../src/run.js') as unknown as {
      snapshotWindowsTree: (pid: number) => Promise<Array<{ pid: number; startTicks: string }> | undefined>;
      terminateWindowsTree: (identities: Array<{ pid: number; startTicks: string }>) => Promise<boolean>;
    };
    const identities = await Promise.all(targets.map(async target => (await module.snapshotWindowsTree(target.pid!))?.find(item => item.pid === target.pid)));
    assert.ok(identities.every(Boolean));
    assert.equal(await module.terminateWindowsTree(identities as Array<{ pid: number; startTicks: string }>), true);
    for (const target of targets) {
      const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${target.pid} -ErrorAction SilentlyContinue`], { encoding: 'utf8' });
      assert.equal(query.stdout.trim(), '', `recorded PID ${target.pid} survived`);
    }
  } finally {
    for (const target of targets) if (target.pid) spawnSync('taskkill', ['/PID', String(target.pid), '/T', '/F'], { stdio: 'ignore' });
  }
});

test('POSIX executable script with a spaced path receives metacharacter argv', { skip: process.platform === 'win32' }, async t => {
  const dir = await makeTempDir(t, 'fusion script fixture ');
  const script = join(dir, 'argv fixture');
  await writeFile(script, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const args = ['a b', 'x&y', 'q|r', '雪'];
  const evidence = new EvidenceStore();
  const result = await runCommand({ argv: [script, ...args] }, evidence);
  const page = await evidence.expand({ id: result.stdout.id });
  assert.equal(result.exitCode, 0);
  assert.equal(page.status, 'ok');
  if (page.status === 'ok') assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), args.join('\n') + '\n');
});
