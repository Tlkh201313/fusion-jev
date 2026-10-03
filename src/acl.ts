import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

/**
 * Private evidence storage. On Windows the cache directory must carry an ACL that grants access
 * only to the current user, SYSTEM and Administrators; anything else is repaired (and all old
 * receipts discarded) before a receipt is read or written.
 *
 * Verification has two stages. A cheap read-only check (icacls /save plus whoami, about 100 ms)
 * can prove the directory and every file in it are already private. Only when it cannot prove
 * that, or fails in any way, does the authoritative PowerShell script run; that script verifies
 * again and repairs. The script never mutates anything without an explicit "GO" from this module,
 * so a verification whose answer is no longer needed can be killed safely unless a repair began.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_FACTOR = 3;

/** First-attempt limit for the PowerShell verification; the single retry gets three times as long. */
export function aclTimeoutMs(): number {
  const value = process.env.FUSION_ACL_TIMEOUT_MS;
  return value && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : DEFAULT_TIMEOUT_MS;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const systemExecutable = (...parts: string[]): string => {
  // FUSION_SYSTEM_ROOT is a test seam: a child Node cannot start under a fake SystemRoot, but can run with a fake lookup root.
  const file = join(process.env.FUSION_SYSTEM_ROOT ?? process.env.SystemRoot ?? 'C:/Windows', 'System32', ...parts);
  if (!isAbsolute(file)) throw new Error('Windows system executable path must be absolute');
  return file;
};
const powershellPath = () => systemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe');
const lockPath = (directory: string) => `${directory}.acl-repair.lock`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:FUSION_EVIDENCE_ACL_PATH
$isDirectory = $env:FUSION_EVIDENCE_ACL_DIRECTORY -eq '1'
$lock = $target + '.acl-repair.lock'
$mutex = [System.Threading.Mutex]::new($false, $env:FUSION_EVIDENCE_ACL_MUTEX)
$held = $false
try {
try { $got = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $got = $true }
if (-not $got) { throw 'Timed out waiting for evidence ACL repair' }
$held = $true
function Test-PrivateAcl([string]$item, [bool]$isDir) {
  if ($isDir) { $acl = [System.IO.Directory]::GetAccessControl($item) }
  else { $acl = [System.IO.File]::GetAccessControl($item) }
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
  $selfAllowed = $false
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($allowed -notcontains $sid) { return $false }
    if ($sid -eq $current) { $selfAllowed = $true }
  }
  return $selfAllowed
}
function Protect-Item([string]$item, [bool]$isDir) {
  if ($isDir) { $acl = [System.IO.Directory]::GetAccessControl($item) }
  else { $acl = [System.IO.File]::GetAccessControl($item) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) | Out-Null }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $inheritance = if ($isDir) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
    else { [System.Security.AccessControl.InheritanceFlags]::None }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  if ($isDir) { [System.IO.Directory]::SetAccessControl($item, $acl) }
  else { [System.IO.File]::SetAccessControl($item, $acl) }
}
$wasTrusted = Test-PrivateAcl $target $isDirectory
if ($isDirectory) {
  foreach ($item in [System.IO.Directory]::EnumerateFiles($target, '*', [System.IO.SearchOption]::TopDirectoryOnly)) {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      try {
        if (([System.IO.File]::GetAttributes($item) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $wasTrusted = $false }
        elseif (-not (Test-PrivateAcl $item $false)) { $wasTrusted = $false }
        break
      } catch {
        # Another process's SQLite journal files come and go: skip a file that is gone, re-check one that was recreated.
        $inner = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }
        $vanished = $inner -is [System.IO.FileNotFoundException] -or $inner -is [System.IO.DirectoryNotFoundException]
        if (-not [System.IO.File]::Exists($item)) { break }
        if (-not $vanished -or $attempt -ge 2) { throw }
      }
    }
  }
}
if ($wasTrusted) {
  # Nothing to repair: the directory and every file already grant only the current user, SYSTEM and Administrators.
  [Console]::Out.WriteLine('TRUSTED')
} else {
  # Mutation needs the caller's explicit go-ahead, so an abandoned verification can be killed before this point.
  [Console]::Out.WriteLine('NEEDREPAIR')
  if ([Console]::In.ReadLine() -ne 'GO') { throw 'Evidence ACL repair was not authorized' }
  [System.IO.File]::WriteAllText($lock, '1')
  try {
  Protect-Item $target $isDirectory
  if ($isDirectory) {
    foreach ($item in [System.IO.Directory]::EnumerateFiles($target, '*', [System.IO.SearchOption]::TopDirectoryOnly)) {
      $name = [System.IO.Path]::GetFileName($item)
      if ($name -match '^(?:[a-f0-9-]{36}\\.json|(?:[a-f0-9-]{36}|\\.research-provenance-[a-f0-9]{64}-[a-f0-9-]{36})\\.tmp|\\.research-provenance-[a-f0-9]{64}\\.json|research-provenance\\.sqlite(?:-(?:journal|wal|shm))?)$') {
        [System.IO.File]::Delete($item)
      }
    }
    foreach ($item in [System.IO.Directory]::EnumerateFiles($target, '*', [System.IO.SearchOption]::TopDirectoryOnly)) {
      for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
          if (([System.IO.File]::GetAttributes($item) -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { Protect-Item $item $false }
          break
        } catch {
          # Another process's SQLite journal files come and go: skip a file that is gone, re-protect one that was recreated.
          $inner = if ($_.Exception.InnerException) { $_.Exception.InnerException } else { $_.Exception }
          $vanished = $inner -is [System.IO.FileNotFoundException] -or $inner -is [System.IO.DirectoryNotFoundException]
          if (-not [System.IO.File]::Exists($item)) { break }
          if (-not $vanished -or $attempt -ge 2) { throw }
        }
      }
    }
  }
  } finally { [System.IO.File]::Delete($lock) }
  [Console]::Out.WriteLine('UNTRUSTED')
}
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;

function scriptEnv(path: string, directory: boolean): NodeJS.ProcessEnv {
  return { ...process.env, FUSION_EVIDENCE_ACL_PATH: path, FUSION_EVIDENCE_ACL_DIRECTORY: directory ? '1' : '0',
    FUSION_EVIDENCE_ACL_MUTEX: `Local\\FusionEvidenceAcl-${sha(path.toLowerCase()).slice(0, 32)}` };
}
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', SCRIPT];

function verdict(stdout: string): boolean | undefined {
  const last = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop();
  return last === 'TRUSTED' ? true : last === 'UNTRUSTED' ? false : undefined;
}

function failure(reason: unknown): Error {
  const first = String(reason ?? '').split(/\r?\n/, 1)[0]?.trim();
  return new Error('Unable to make evidence storage private' + (first ? ` (${first})` : ''));
}

// ---------------------------------------------------------------------------------------------
// Stage 1: read-only proof that the directory and its files are already private.

const ALWAYS_TRUSTED = new Set(['SY', 'BA', 'S-1-5-18', 'S-1-5-32-544']);

/** Returns true only when every allow entry names the current user, SYSTEM or Administrators and the user has one. */
export function sddlIsPrivate(sddl: string, currentSid: string): boolean {
  const match = /^D:([A-Z]*)((?:\([^()]*\))*)(?:S:.*)?$/.exec(sddl.trim());
  if (!match) return false;
  let self = false;
  for (const ace of match[2]!.split(/(?<=\))(?=\()/).filter(Boolean)) {
    const fields = ace.slice(1, -1).split(';');
    if (fields.length !== 6) return false;
    const [type, , , , , trustee] = fields as [string, string, string, string, string, string];
    if (type === 'D') continue; // The PowerShell check ignores deny entries too.
    if (type !== 'A') return false;
    if (trustee === currentSid) self = true;
    else if (!ALWAYS_TRUSTED.has(trustee)) return false;
  }
  return self;
}

/** Parses `icacls /save` output (UTF-16LE: a name line then its SDDL line) into name -> SDDL. */
export function parseIcaclsSave(bytes: Buffer): Map<string, string> | undefined {
  const lines = bytes.toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length % 2 !== 0) return undefined;
  const entries = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 2) {
    if (entries.has(lines[index]!)) return undefined;
    entries.set(lines[index]!, lines[index + 1]!);
  }
  return entries;
}

function currentSidFrom(output: string): string | undefined {
  return /^"[^"]*","(S-1-5-21-[\d-]+|S-1-5-\d+(?:-\d+)*)"\s*$/.exec(output.trim())?.[1];
}

/** Directory entries must all be plain files for the fast check to speak for them. */
function plainFileNames(directory: string): string[] | undefined {
  const names: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
    names.push(entry.name);
  }
  return names;
}

interface FastPlan { names: string[]; tmp: string; dirSave: string; filesSave: string; commands: Array<{ file: string; args: string[] }> }

function planFastCheck(directory: string): FastPlan | undefined {
  if (existsSync(lockPath(directory))) return undefined;
  const names = plainFileNames(directory);
  if (!names) return undefined;
  const tmp = mkdtempSync(join(tmpdir(), 'fusion-acl-'));
  const dirSave = join(tmp, 'dir.txt'), filesSave = join(tmp, 'files.txt');
  const icacls = systemExecutable('icacls.exe');
  return { names, tmp, dirSave, filesSave, commands: [
    { file: icacls, args: [directory, '/save', dirSave] },
    ...(names.length ? [{ file: icacls, args: [join(directory, '*'), '/save', filesSave, '/c'] }] : []),
    { file: systemExecutable('whoami.exe'), args: ['/user', '/fo', 'csv', '/nh'] },
  ] };
}

function judgeFastCheck(directory: string, plan: FastPlan, whoami: string): boolean {
  const sid = currentSidFrom(whoami);
  if (!sid) return false;
  const dir = parseIcaclsSave(readFileSync(plan.dirSave));
  if (!dir || dir.size !== 1 || !sddlIsPrivate([...dir.values()][0]!, sid)) return false;
  if (plan.names.length) {
    const files = parseIcaclsSave(readFileSync(plan.filesSave));
    if (!files) return false;
    for (const name of plan.names) {
      const sddl = files.get(name);
      if (sddl === undefined || !sddlIsPrivate(sddl, sid)) return false;
    }
  }
  // A repair that began after the reads above would have left its lock file behind.
  if (existsSync(lockPath(directory))) return false;
  // Every file must still be a plain file with the same names; anything that moved is for PowerShell to judge.
  const after = plainFileNames(directory);
  return Boolean(after) && after!.length === plan.names.length && after!.every(name => plan.names.includes(name));
}

function fastCheckSync(directory: string): boolean {
  let plan: FastPlan | undefined;
  try {
    plan = planFastCheck(directory);
    if (!plan) return false;
    let whoami = '';
    for (const command of plan.commands) {
      const result = spawnSync(command.file, command.args, { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      if (command.file.endsWith('whoami.exe')) whoami = result.stdout ?? '';
      else if (result.status !== 0) return false;
    }
    return judgeFastCheck(directory, plan, whoami);
  } catch { return false; }
  finally { if (plan) rmSync(plan.tmp, { recursive: true, force: true }); }
}

function fastCheckAsync(directory: string, signal: AbortSignal): Promise<boolean> {
  let plan: FastPlan | undefined;
  try { plan = planFastCheck(directory); } catch { return Promise.resolve(false); }
  if (!plan) return Promise.resolve(false);
  const ready = plan;
  const run = (command: FastPlan['commands'][number]) => new Promise<{ ok: boolean; stdout: string }>(resolve => {
    let stdout = '';
    const child = spawn(command.file, command.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], signal });
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); resolve({ ok: false, stdout }); });
    child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout }); });
  });
  return Promise.all(ready.commands.map(run)).then(results => {
    if (signal.aborted) return false;
    const whoamiIndex = ready.commands.findIndex(command => command.file.endsWith('whoami.exe'));
    if (results.some((result, index) => index !== whoamiIndex && !result.ok)) return false;
    return judgeFastCheck(directory, ready, results[whoamiIndex]!.stdout);
  }).catch(() => false).finally(() => rmSync(ready.tmp, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------------------------
// Stage 2: the authoritative PowerShell script.

/** Synchronous verification for callers that cannot await (constructors, MCP startup). */
export function verifyDirectoryAclSync(directory: string): boolean {
  if (fastCheckSync(directory)) return true;
  let limit = aclTimeoutMs();
  for (let attempt = 0; ; attempt++) {
    const result = spawnSync(powershellPath(), POWERSHELL_ARGS, {
      windowsHide: true, encoding: 'utf8', timeout: limit, input: 'GO\n', env: scriptEnv(directory, true),
    });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    if (timedOut && attempt === 0) { limit *= RETRY_FACTOR; continue; }
    const answer = result.status === 0 ? verdict(result.stdout) : undefined;
    if (answer === undefined) throw failure(result.error?.message ?? result.stderr);
    return answer;
  }
}

type Attempt = { kind: 'done'; trusted: boolean } | { kind: 'timeout'; repairing: boolean } | { kind: 'failed'; reason: string };

/** An in-flight directory ACL verification that can be awaited or, while still read-only, abandoned. */
export class AclVerification {
  readonly result: Promise<boolean>;
  private readonly abort = new AbortController();
  private child: ChildProcess | undefined;
  private repairing = false;
  private settled = false;

  constructor(private readonly directory: string) {
    this.result = this.run().finally(() => { this.settled = true; });
    this.result.catch(() => undefined); // A result nobody awaits (abandoned verification) must not be an unhandled rejection.
  }

  /** Stops a verification whose answer is no longer needed; a repair already underway is allowed to finish. */
  async abandon(): Promise<void> {
    if (this.settled) return;
    if (!this.repairing) {
      this.abort.abort();
      this.child?.kill();
    }
    try { await this.result; } catch { /* Only completion matters here. */ }
  }

  private async run(): Promise<boolean> {
    if (await fastCheckAsync(this.directory, this.abort.signal)) return true;
    if (this.abort.signal.aborted) throw new Error('Evidence ACL verification abandoned');
    let limit = aclTimeoutMs();
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(limit);
      if (outcome.kind === 'done') return outcome.trusted;
      if (this.abort.signal.aborted) throw new Error('Evidence ACL verification abandoned');
      if (outcome.kind === 'failed') throw failure(outcome.reason);
      if (attempt > 0 || outcome.repairing) throw failure(`powershell.exe timed out after ${limit} ms`);
      limit *= RETRY_FACTOR;
    }
  }

  private attempt(limit: number): Promise<Attempt> {
    return new Promise(resolve => {
      let stdout = '', stderr = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      let child: ChildProcess;
      try {
        child = spawn(powershellPath(), POWERSHELL_ARGS, { windowsHide: true, env: scriptEnv(this.directory, true), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { resolve({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) }); return; }
      this.child = child;
      this.repairing = false;
      const expire = () => {
        if (!this.repairing) { child.kill(); resolve({ kind: 'timeout', repairing: false }); return; }
        // Never kill a repair midway: wait for it for as long again, then give up on it without touching it.
        timer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); resolve({ kind: 'timeout', repairing: true }); }, limit * RETRY_FACTOR);
      };
      timer = setTimeout(expire, limit);
      child.stdin!.on('error', () => undefined);
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (!this.repairing && /^NEEDREPAIR\s*$/m.test(stdout)) {
          this.repairing = true;
          child.stdin!.write('GO\n');
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
      child.once('error', error => { clearTimeout(timer); resolve({ kind: 'failed', reason: error.message }); });
      child.once('close', code => {
        clearTimeout(timer);
        const answer = code === 0 ? verdict(stdout) : undefined;
        resolve(answer === undefined ? { kind: 'failed', reason: stderr || `powershell.exe exited with ${code}` } : { kind: 'done', trusted: answer });
      });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Storage directory preparation.

declare const verifiedBrand: unique symbol;
/** A storage directory whose privacy was verified by this module. Only this module can mint one. */
export interface VerifiedStorage { readonly path: string; readonly trusted: boolean; readonly [verifiedBrand]: true }
const minted = new WeakSet<object>();
const mint = (path: string, trusted: boolean): VerifiedStorage => {
  const value = Object.freeze({ path, trusted }) as unknown as VerifiedStorage;
  minted.add(value);
  return value;
};
export const isVerifiedStorage = (value: unknown): value is VerifiedStorage => typeof value === 'object' && value !== null && minted.has(value);

function localAppData(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('Evidence storage requires a private LOCALAPPDATA directory on Windows');
  return realpathSync.native(local).toLowerCase();
}

/** Creates the directory if needed and applies every check that needs no ACL inspection. Returns the real path. */
function prepareDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Evidence storage requires a private non-symlink directory');
  const actual = realpathSync.native(path);
  if (process.platform === 'win32') {
    // LOCALAPPDATA inherits the current user's Windows profile ACL; the CLI cache lives there.
    const local = localAppData();
    const lower = actual.toLowerCase();
    if (!(lower === local || lower.startsWith(local + sep.toLowerCase())))
      throw new Error('Evidence storage requires a private LOCALAPPDATA directory on Windows');
  } else if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Evidence storage directory permissions are not private');
  }
  return actual;
}

/** Synchronous preparation and verification. */
export function verifyStorageSync(path: string): VerifiedStorage {
  const actual = prepareDirectory(path);
  return mint(actual, process.platform === 'win32' ? verifyDirectoryAclSync(actual) : true);
}

/**
 * Begins verifying a storage directory without blocking. When the directory already exists the
 * (Windows) ACL verification starts immediately, so it overlaps whatever the caller does next;
 * otherwise nothing is created until `ready()` is awaited. Nothing is written to the directory
 * before verification completes.
 */
export class StorageVerification {
  private verification: AclVerification | undefined;
  private actual: string | undefined;
  private outcome: Promise<VerifiedStorage> | undefined;

  constructor(private readonly path: string) {
    if (process.platform !== 'win32') return;
    try {
      if (!lstatSync(path).isDirectory()) return;
      this.actual = prepareDirectory(path);
      this.verification = new AclVerification(this.actual);
    } catch { this.actual = undefined; this.verification = undefined; /* ready() reports the real error. */ }
  }

  ready(): Promise<VerifiedStorage> {
    return this.outcome ??= (async () => {
      if (process.platform !== 'win32') return mint(prepareDirectory(this.path), true);
      if (!this.verification) {
        this.actual = prepareDirectory(this.path);
        this.verification = new AclVerification(this.actual);
      }
      return mint(this.actual!, await this.verification.result);
    })();
  }

  /** Call when no receipt will be stored after all. */
  async discard(): Promise<void> {
    if (this.outcome) { try { await this.outcome; } catch { /* Reported by whoever awaited ready(). */ } return; }
    await this.verification?.abandon();
  }
}
