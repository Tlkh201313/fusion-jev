import spawn from 'cross-spawn';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { isAbsolute, join } from 'node:path';
import { EvidenceStore, type EvidenceReceipt } from './evidence.js';

export interface RunInput {
  argv: [string, ...string[]]; cwd?: string; timeoutMs?: number; maxCaptureBytes?: number; raw?: boolean;
}
export interface RunResult {
  termination: 'exit' | 'signal' | 'timeout' | 'cancelled' | 'spawn_error';
  exitCode: number | null; signal?: string; errorCode?: 'not_found' | 'access_denied' | 'launch_failed';
  cleanupFailed?: boolean;
  stdout: EvidenceReceipt; stderr: EvidenceReceipt; durationMs: number;
  /** Set when persistent evidence storage failed; receipts then live only in this store. */
  evidence?: EvidenceStore; evidenceUnavailable?: true;
}

const MAX_CAPTURE = 8 * 1024 * 1024;

interface WindowsIdentity { pid: number; startTicks: string }

const WINDOWS_TREE_SNAPSHOT = `
$ErrorActionPreference = 'Stop'
$rootProcessId = [int]$env:FUSION_RUN_ROOT_PID
$root = [System.Diagnostics.Process]::GetProcessById($rootProcessId)
if ($root.HasExited) { exit 2 }
$rootTicks = $root.StartTime.ToUniversalTime().Ticks.ToString()
$snapshot = @(Get-CimInstance Win32_Process)
$rootRecord = @($snapshot | Where-Object { [int]$_.ProcessId -eq $rootProcessId })
if ($rootRecord.Count -ne 1 -or [Math]::Abs([long]$rootRecord[0].CreationDate.ToUniversalTime().Ticks - [long]$rootTicks) -ge 10) { exit 2 }
$known = [System.Collections.Generic.HashSet[int]]::new()
[void]$known.Add($rootProcessId)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($item in $snapshot) {
    if ($known.Contains([int]$item.ParentProcessId) -and $known.Add([int]$item.ProcessId)) { $changed = $true }
  }
}
$records = @()
foreach ($item in $snapshot) {
  if (-not $known.Contains([int]$item.ProcessId)) { continue }
  if ($records.Count -ge 256) { exit 2 }
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$item.ProcessId)
    if ($process.HasExited) { exit 2 }
    $ticks = $process.StartTime.ToUniversalTime().Ticks.ToString()
    if ([Math]::Abs([long]$item.CreationDate.ToUniversalTime().Ticks - [long]$ticks) -ge 10) { exit 2 }
    $records += @{ pid = [int]$item.ProcessId; startTicks = $ticks }
  } catch { exit 2 }
}
if ($root.HasExited) { exit 2 }
[Console]::Out.Write((ConvertTo-Json -InputObject $records -Compress -Depth 4))
`;

const WINDOWS_TREE_TERMINATE = `
$ErrorActionPreference = 'Stop'
$records = ConvertFrom-Json -InputObject $env:FUSION_RUN_IDENTITIES
$failed = $false
foreach ($record in $records) {
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$record.pid)
  } catch { continue }
  try {
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$record.startTicks) {
      $failed = $true
      continue
    }
    $process.Kill()
    if (-not $process.WaitForExit(1000)) { $failed = $true }
  } catch {
    if (-not $process.HasExited) { $failed = $true }
  } finally { $process.Dispose() }
}
if ($failed) { exit 1 }
exit 0
`;

function runWindowsHelper(script: string, environment: Record<string, string>): Promise<string | undefined> {
  return new Promise(resolve => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const command = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = nodeSpawn(command, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false,
      env: { ...process.env, ...environment },
    });
    let done = false;
    let output = '';
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { helper.kill('SIGKILL'); finish(undefined); }, 3500);
    helper.stdout?.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 64 * 1024) { helper.kill('SIGKILL'); finish(undefined); }
      else output += chunk.toString('utf8');
    });
    helper.once('error', () => finish(undefined));
    helper.once('close', code => finish(code === 0 ? output : undefined));
  });
}

export async function snapshotWindowsTree(rootPid: number): Promise<WindowsIdentity[] | undefined> {
  const output = await runWindowsHelper(WINDOWS_TREE_SNAPSHOT, { FUSION_RUN_ROOT_PID: String(rootPid) });
  if (!output) return undefined;
  try {
    const value: unknown = JSON.parse(output);
    if (!Array.isArray(value) || value.length < 1 || value.length > 256 || value.some(item =>
      !item || typeof item !== 'object' || !Number.isSafeInteger(item.pid) || item.pid < 1 ||
      typeof item.startTicks !== 'string' || !/^[1-9]\d{0,19}$/.test(item.startTicks))) return undefined;
    if (!value.some(item => item.pid === rootPid)) return undefined;
    return value as WindowsIdentity[];
  } catch { return undefined; }
}

// Exported from this module for a direct PID-reuse safety regression; the package index does not expose it.
export async function terminateWindowsTree(identities: WindowsIdentity[]): Promise<boolean> {
  if (!identities.length || identities.length > 256 || identities.some(item =>
    !Number.isSafeInteger(item.pid) || item.pid < 1 || !/^[1-9]\d{0,19}$/.test(item.startTicks))) return false;
  const result = await runWindowsHelper(WINDOWS_TREE_TERMINATE, { FUSION_RUN_IDENTITIES: JSON.stringify(identities) });
  return result !== undefined;
}

// A snapshot is never accepted unless the launched process is still known to be live
// both before the helper starts and after it returns.
export async function captureWindowsIdentity(
  snapshot: () => Promise<WindowsIdentity[] | undefined>, canTrustRoot: () => boolean,
): Promise<WindowsIdentity[] | undefined> {
  if (!canTrustRoot()) return undefined;
  const identities = await snapshot();
  return canTrustRoot() ? identities : undefined;
}

export async function cleanupWindowsTree(
  rootPid: number, identitySnapshot: Promise<WindowsIdentity[] | undefined>, canTrustRoot: () => boolean,
  snapshot: (pid: number) => Promise<WindowsIdentity[] | undefined> = snapshotWindowsTree,
  terminate: (identities: WindowsIdentity[]) => Promise<boolean> = terminateWindowsTree,
): Promise<boolean> {
  const initial = await identitySnapshot;
  if (!initial) return false;
  // A live, identity-verified root can safely seed one final descendant snapshot.
  // After its exit, numeric parent IDs can be reused; only previously recorded identities may be touched.
  const final = await captureWindowsIdentity(() => snapshot(rootPid), canTrustRoot);
  const identities = new Map<number, WindowsIdentity>();
  for (const item of initial) identities.set(item.pid, item);
  for (const item of final ?? []) {
    const prior = identities.get(item.pid);
    if (prior && prior.startTicks !== item.startTicks) return false;
    identities.set(item.pid, item);
  }
  if (final && !canTrustRoot()) return false;
  const killed = await terminate([...identities.values()]);
  return killed && Boolean(final);
}

// A child that has reported exit can no longer bind PID-based discovery to
// the launched process. Use only the public ChildProcess lifecycle state.
export function canTrustWindowsRoot(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, exitObserved: boolean): boolean {
  return !exitObserved && child.exitCode === null && child.signalCode === null;
}

async function killTree(child: ChildProcess, identitySnapshot: Promise<WindowsIdentity[] | undefined>, canTrustRoot: () => boolean): Promise<boolean> {
  if (!child.pid) return false;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return true; }
    catch { try { child.kill('SIGKILL'); return true; } catch { return false; } }
  }
  return cleanupWindowsTree(child.pid, identitySnapshot, canTrustRoot);
}

function errorCode(error: Error): RunResult['errorCode'] {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' ? 'not_found' : code === 'EACCES' || code === 'EPERM' ? 'access_denied' : 'launch_failed';
}

// After the direct child exits, wait this long for descendants to release the
// output pipes before reporting the child's own status (no timeout configured).
const PIPE_GRACE_MS = 1500;
// POSIX processes first receive the forwarded signal so they can clean up
// (for example Git lock files); survivors are killed after this grace period.
const SIGNAL_GRACE_MS = 2000;

function forwardedSignal(signal: AbortSignal | undefined): NodeJS.Signals {
  const reason: unknown = signal?.reason;
  return typeof reason === 'string' && /^SIG[A-Z0-9]+$/.test(reason) ? reason as NodeJS.Signals : 'SIGTERM';
}

export async function runCommand(input: RunInput, evidence: EvidenceStore, signal?: AbortSignal): Promise<RunResult> {
  if (!Array.isArray(input.argv) || !input.argv.length || input.argv.some(arg => typeof arg !== 'string') || !input.argv[0])
    throw new TypeError('Command argv must include a program');
  if (input.cwd !== undefined && !isAbsolute(input.cwd)) throw new TypeError('Command cwd must be absolute');
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647))
    throw new RangeError('Invalid command timeout');
  const maxCaptureBytes = input.maxCaptureBytes ?? MAX_CAPTURE;
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1 || maxCaptureBytes > MAX_CAPTURE)
    throw new RangeError('Invalid command capture limit');
  const cwd = input.cwd ?? process.cwd();
  const started = performance.now();
  const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  const originals = { stdout: 0, stderr: 0 };
  const pendingDrains = new Map<Promise<void>, () => void>();
  const brokenSinks = new Set<NodeJS.WriteStream>();
  // A closed reader (for example `| head`) must not crash the wrapper or change the child's status.
  const onSinkError = (sink: NodeJS.WriteStream) => () => {
    brokenSinks.add(sink);
    for (const release of pendingDrains.values()) release();
  };
  const sinkHandlers = input.raw ? ([process.stdout, process.stderr] as const).map(sink => [sink, onSinkError(sink)] as const) : [];
  for (const [sink, handler] of sinkHandlers) sink.on('error', handler);
  const capture = (channel: 'stdout' | 'stderr', chunk: Buffer, source: Readable) => {
    originals[channel] += chunk.length;
    const remaining = maxCaptureBytes - sizes[channel];
    if (remaining > 0) {
      const kept = Buffer.from(chunk.subarray(0, remaining));
      chunks[channel].push(kept);
      sizes[channel] += kept.length;
    }
    if (input.raw) {
      const sink = channel === 'stdout' ? process.stdout : process.stderr;
      if (brokenSinks.has(sink)) return;
      if (!sink.write(chunk)) {
        source.pause();
        let release!: () => void;
        const drained = new Promise<void>(resolve => {
          release = () => { sink.removeListener('drain', release); source.resume(); resolve(); };
          sink.once('drain', release);
        });
        pendingDrains.set(drained, release);
        void drained.then(() => pendingDrains.delete(drained));
      }
    }
  };
  const finish = (fields: Pick<RunResult, 'termination' | 'exitCode' | 'signal' | 'errorCode' | 'cleanupFailed'>, incomplete = false): RunResult => {
    for (const [sink, handler] of sinkHandlers) sink.removeListener('error', handler);
    const source = (channel: 'stdout' | 'stderr') => ({ kind: 'command' as const, cwd, argv: [...input.argv], channel });
    const receipts = (store: EvidenceStore) => ({
      stdout: store.capture({ source: source('stdout'), bytes: Buffer.concat(chunks.stdout), originalBytes: incomplete ? null : originals.stdout,
        truncated: incomplete || originals.stdout > sizes.stdout }),
      stderr: store.capture({ source: source('stderr'), bytes: Buffer.concat(chunks.stderr), originalBytes: incomplete ? null : originals.stderr,
        truncated: incomplete || originals.stderr > sizes.stderr }),
    });
    try { return { ...fields, ...receipts(evidence), durationMs: performance.now() - started }; }
    catch {
      // Persistent storage failed (disk full, permissions): keep the child's status and an in-process copy.
      const fallback = new EvidenceStore();
      return { ...fields, ...receipts(fallback), evidence: fallback, evidenceUnavailable: true, durationMs: performance.now() - started };
    }
  };
  if (signal?.aborted) return finish({ termination: 'cancelled', exitCode: null });

  return await new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      // A batch file that forwards `%*` reparses metacharacters. cross-spawn doubles
      // escaping for node_modules/.bin shims; apply that same protection to other
      // explicit .cmd/.bat launchers before cross-spawn's normal escaping pass.
      const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(input.argv[0]) &&
        !/node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(input.argv[0]);
      const argv = batch ? input.argv.slice(1).map(arg => arg.replace(/([()%!^<>&|;,])/g, '^$1')) : input.argv.slice(1);
      child = spawn(input.argv[0], argv, {
        cwd, shell: false, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32', windowsVerbatimArguments: false,
      });
    } catch (error) {
      resolve(finish({ termination: 'spawn_error', exitCode: null, errorCode: errorCode(error as Error) }));
      return;
    }
    let exitObserved = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const rootIsLive = () => canTrustWindowsRoot(child, exitObserved);
    const takeSnapshot = () => process.platform === 'win32' && child.pid && rootIsLive()
      ? captureWindowsIdentity(() => snapshotWindowsTree(child.pid!), rootIsLive).then(async first => {
        if (!first) return undefined;
        // One later snapshot records descendants spawned just after the root.
        // This is bounded to two queries rather than a persistent CIM poll.
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 200); timer.unref(); });
        const second = await captureWindowsIdentity(() => snapshotWindowsTree(child.pid!), rootIsLive);
        if (!second) return first;
        const merged = new Map(first.map(item => [item.pid, item]));
        for (const item of second) {
          const prior = merged.get(item.pid);
          if (prior && prior.startTicks !== item.startTicks) return undefined;
          merged.set(item.pid, item);
        }
        return [...merged.values()];
      })
      : Promise.resolve(undefined);
    // A timeout needs the early snapshot to reach descendants after the root exits.
    // Plain runs snapshot only when cancellation actually happens.
    let identitySnapshot: Promise<WindowsIdentity[] | undefined> | undefined = input.timeoutMs !== undefined ? takeSnapshot() : undefined;
    let reason: 'timeout' | 'cancelled' | undefined;
    let launchedError: Error | undefined;
    let cleanupFailed = false;
    let cleanup: Promise<boolean> | undefined;
    let escalate: (() => void) | undefined;
    let forced: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let pipeTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (fields: Pick<RunResult, 'termination' | 'exitCode' | 'signal' | 'errorCode' | 'cleanupFailed'>, incomplete = false) => {
      if (settled) return;
      settled = true;
      for (const pending of [timer, forced, graceTimer, pipeTimer]) if (pending) clearTimeout(pending);
      signal?.removeEventListener('abort', onAbort);
      try { resolve(finish(fields, incomplete)); } catch (error) { reject(error); }
    };
    const stop = (why: 'timeout' | 'cancelled') => {
      if (reason || launchedError) return;
      reason = why;
      const kill = () => {
        escalate = undefined;
        if (graceTimer) clearTimeout(graceTimer);
        identitySnapshot ??= takeSnapshot();
        cleanup = killTree(child, identitySnapshot, rootIsLive).then(ok => {
          if (!ok) {
            cleanupFailed = true;
            try { child.kill('SIGKILL'); } catch { /* The direct child may already have exited. */ }
          }
          return ok;
        });
      };
      let grace = 0;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, why === 'cancelled' ? forwardedSignal(signal) : 'SIGTERM');
          grace = SIGNAL_GRACE_MS;
          escalate = kill;
          graceTimer = setTimeout(kill, grace);
        } catch { kill(); }
      } else kill();
      forced = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy();
        settle({ termination: why, exitCode: exited?.code ?? null, cleanupFailed: true }, true);
      }, grace + 4500);
    };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => stop('timeout'), input.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk, child.stdout!));
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk, child.stderr!));
    child.once('error', error => { launchedError = error; });
    child.once('exit', (code, endedSignal) => {
      exitObserved = true;
      exited = { code, signal: endedSignal };
      // Descendants (test workers, `server &`) can hold the pipes open indefinitely.
      // Without a timeout, report the child's own status once it exits.
      if (input.timeoutMs !== undefined || reason) return;
      pipeTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy();
        for (const release of pendingDrains.values()) release();
        settle(endedSignal ? { termination: 'signal', exitCode: null, signal: endedSignal } : { termination: 'exit', exitCode: code }, true);
      }, PIPE_GRACE_MS);
    });
    child.once('close', async (code, endedSignal) => {
      // Everything released the pipes; finish any pending group kill immediately.
      escalate?.();
      if (cleanup) await cleanup;
      await Promise.all([...pendingDrains.keys()]);
      if (launchedError) settle({ termination: 'spawn_error', exitCode: null, errorCode: errorCode(launchedError) });
      else if (reason) settle({ termination: reason, exitCode: exited?.code ?? null, ...(endedSignal ? { signal: endedSignal } : {}), ...(cleanupFailed ? { cleanupFailed: true } : {}) });
      else if (endedSignal) settle({ termination: 'signal', exitCode: null, signal: endedSignal });
      else settle({ termination: 'exit', exitCode: code });
    });
  });
}
