import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Database } from './sqlite.js';
import { safeWorkspaceBytes } from './workspace.js';
import { isSecretName, redactSecrets } from './secrets.js';

export type EvidenceSource =
  | { kind: 'workspace'; root: string; path: string }
  | { kind: 'derived_workspace'; root: string; path: string; operation: 'list' | 'search'; query?: string }
  | { kind: 'command'; cwd: string; argv: string[]; channel: 'stdout' | 'stderr' }
  | { kind: 'research'; url: string; title?: string; retrievedAt: string; passageId: string; sourceTool: 'host_search' | 'host_browser' | 'host_docs'; untrusted: true };
export interface EvidenceCapture { source: EvidenceSource; bytes: Buffer; originalBytes?: number | null; redacted?: boolean; truncated?: boolean }
export interface EvidenceReceipt {
  id: string; sha256: string; storedBytes: number; originalBytes: number | null;
  redacted: boolean; truncated: boolean; expiresAt: number; source: EvidenceSource;
}
export type EvidencePage =
  | { status: 'ok' | 'stale'; receipt: EvidenceReceipt; startByte: number; nextByte: number | null; dataBase64: string }
  | { status: 'missing' | 'expired' | 'hash_mismatch'; id: string };

interface Entry { receipt: EvidenceReceipt; bytes: Buffer; sourceHash?: string; canonicalPath?: string; order: number }
const MAX_CAPTURE = 8 * 1024 * 1024;
const MAX_PAGE = 64 * 1024;
const DEFAULT_PAGE = 16 * 1024;
const MAX_DISK_FILE = 12 * 1024 * 1024;
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', '.next']);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type ResearchSource = Extract<EvidenceSource, { kind: 'research' }>;
function sameResearchSource(left: ResearchSource, right: ResearchSource): boolean {
  return left.url === right.url && left.retrievedAt === right.retrievedAt
    && left.passageId === right.passageId && left.sourceTool === right.sourceTool;
}

function researchKey(source: ResearchSource): string {
  return hash(Buffer.from(JSON.stringify([source.url, source.retrievedAt, source.passageId, source.sourceTool])));
}

const receiptFileName = /^[a-f0-9-]{36}\.json$/;
const orphanTemporaryName = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|\.research-provenance-[a-f0-9]{64}-[a-f0-9-]{36})\.tmp$/;
const provenanceFileName = /^\.research-provenance-[a-f0-9]{64}\.json$/;
const receiptId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
interface ProvenanceRow { key: string; id: string; sha256: string; expiresAt: number }
interface ReceiptRow { id: string; sha256: string; storedBytes: number; expiresAt: number; sequence: number }

function hardenWindowsAcl(path: string, directory: boolean): boolean {
  // .NET's ACL API replaces the whole DACL once, avoiding a window with inherited broad access.
  const script = `
$ErrorActionPreference = 'Stop'
$target = $env:FUSION_EVIDENCE_ACL_PATH
$isDirectory = $env:FUSION_EVIDENCE_ACL_DIRECTORY -eq '1'
$mutex = [System.Threading.Mutex]::new($false, $env:FUSION_EVIDENCE_ACL_MUTEX)
$held = $false
try {
if (-not $mutex.WaitOne(10000)) { throw 'Timed out waiting for evidence ACL repair' }
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
    try {
      if (([System.IO.File]::GetAttributes($item) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $wasTrusted = $false }
      elseif (-not (Test-PrivateAcl $item $false)) { $wasTrusted = $false }
    } catch { if ([System.IO.File]::Exists($item)) { throw } }
  }
}
Protect-Item $target $isDirectory
if ($isDirectory) {
  if (-not $wasTrusted) {
    foreach ($item in [System.IO.Directory]::EnumerateFiles($target, '*', [System.IO.SearchOption]::TopDirectoryOnly)) {
      $name = [System.IO.Path]::GetFileName($item)
      if ($name -match '^(?:[a-f0-9-]{36}\.json|(?:[a-f0-9-]{36}|\.research-provenance-[a-f0-9]{64}-[a-f0-9-]{36})\.tmp|\.research-provenance-[a-f0-9]{64}\.json|research-provenance\.sqlite(?:-(?:journal|wal|shm))?)$') {
        [System.IO.File]::Delete($item)
      }
    }
  }
  foreach ($item in [System.IO.Directory]::EnumerateFiles($target, '*', [System.IO.SearchOption]::TopDirectoryOnly)) {
    try {
      if (([System.IO.File]::GetAttributes($item) -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { Protect-Item $item $false }
    } catch { if ([System.IO.File]::Exists($item)) { throw } }
  }
}
[Console]::Out.WriteLine($(if ($wasTrusted) { 'TRUSTED' } else { 'UNTRUSTED' }))
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
  const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!isAbsolute(powershell)) throw new Error('Windows system executable path must be absolute');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, FUSION_EVIDENCE_ACL_PATH: path, FUSION_EVIDENCE_ACL_DIRECTORY: directory ? '1' : '0',
      FUSION_EVIDENCE_ACL_MUTEX: `Local\\FusionEvidenceAcl-${hash(Buffer.from(path.toLowerCase())).slice(0, 32)}` },
  });
  if (result.status !== 0 || !/^(TRUSTED|UNTRUSTED)\s*$/.test(result.stdout)) throw new Error('Unable to make evidence storage private');
  return result.stdout.trim() === 'TRUSTED';
}

function redactKnownSecrets(input: Buffer): { bytes: Buffer; redacted: boolean } {
  // Decode with replacement for pattern detection. If nothing matches, return the untouched raw bytes.
  const text = new TextDecoder('utf-8').decode(input);
  const safe = redactSecrets(text);
  return { bytes: safe === text ? input : Buffer.from(safe), redacted: safe !== text };
}

function canonicalWorkspace(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).some(part => {
    return EXCLUDED.has(part.toLowerCase()) || isSecretName(part);
  })) throw new Error('Invalid workspace path');
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, path);
  if (candidate !== canonicalRoot && !candidate.startsWith(canonicalRoot + sep)) throw new Error('Invalid workspace path');
  const actual = realpathSync(candidate);
  if (actual !== canonicalRoot && !actual.startsWith(canonicalRoot + sep)) throw new Error('Invalid workspace path');
  if (relative(canonicalRoot, actual).split(/[\\/]/).some(part => {
    return EXCLUDED.has(part.toLowerCase()) || isSecretName(part);
  })) throw new Error('Invalid workspace path');
  return actual;
}

function validSource(value: unknown): value is EvidenceSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  if (source.kind === 'workspace') return typeof source.root === 'string' && typeof source.path === 'string';
  if (source.kind === 'derived_workspace') return typeof source.root === 'string' && typeof source.path === 'string'
    && (source.operation === 'list' || source.operation === 'search')
    && (source.query === undefined || typeof source.query === 'string');
  if (source.kind === 'command') return typeof source.cwd === 'string' && Array.isArray(source.argv)
    && source.argv.every(item => typeof item === 'string') && (source.channel === 'stdout' || source.channel === 'stderr');
  if (source.kind === 'research') return typeof source.url === 'string' && typeof source.retrievedAt === 'string'
    && typeof source.passageId === 'string' && (source.title === undefined || typeof source.title === 'string')
    && ['host_search', 'host_browser', 'host_docs'].includes(String(source.sourceTool)) && source.untrusted === true;
  return false;
}

function validDiskEntry(value: unknown, id: string): value is { receipt: EvidenceReceipt; bytes: string; sourceHash?: string; canonicalPath?: string; order?: number } {
  if (!value || typeof value !== 'object') return false;
  const disk = value as Record<string, unknown>;
  if (typeof disk.bytes !== 'string' || !disk.receipt || typeof disk.receipt !== 'object') return false;
  const receipt = disk.receipt as Record<string, unknown>;
  if (receipt.id !== id || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.storedBytes) || (receipt.storedBytes as number) < 0 || (receipt.storedBytes as number) > MAX_CAPTURE
    || !(receipt.originalBytes === null || Number.isSafeInteger(receipt.originalBytes) && (receipt.originalBytes as number) >= 0)
    || typeof receipt.redacted !== 'boolean' || typeof receipt.truncated !== 'boolean'
    || !Number.isSafeInteger(receipt.expiresAt) || !validSource(receipt.source)
    || !(disk.order === undefined || Number.isSafeInteger(disk.order) && (disk.order as number) >= 0)) return false;
  const source = receipt.source as EvidenceSource;
  if (source.kind === 'workspace') return typeof disk.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(disk.sourceHash)
    && typeof disk.canonicalPath === 'string' && isAbsolute(disk.canonicalPath);
  return disk.sourceHash === undefined && disk.canonicalPath === undefined;
}

function privateStorageDirectory(path: string): { path: string; trusted: boolean } {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Evidence storage requires a private non-symlink directory');
  const actual = realpathSync(path);
  let trusted = true;
  if (process.platform === 'win32') {
    // LOCALAPPDATA inherits the current user's Windows profile ACL; Task 2 places the CLI cache there.
    const local = process.env.LOCALAPPDATA;
    if (!local || !(actual.toLowerCase() === realpathSync(local).toLowerCase()
      || actual.toLowerCase().startsWith(realpathSync(local).toLowerCase() + sep.toLowerCase())))
      throw new Error('Evidence storage requires a private LOCALAPPDATA directory on Windows');
    trusted = hardenWindowsAcl(actual, true);
  } else if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Evidence storage directory permissions are not private');
  }
  return { path: actual, trusted };
}

export class EvidenceStore {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: () => number;
  private readonly storageDir?: string;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly removeFile: (path: string) => void;
  private nextOrder = 0;

  constructor(options: { storageDir?: string; clock?: () => number; maxEntries?: number; maxTotalBytes?: number; removeFile?: (path: string) => void } = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxEntries = options.maxEntries ?? 128;
    this.maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
    this.removeFile = options.removeFile ?? (path => rmSync(path, { force: true }));
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || !Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 1)
      throw new RangeError('Invalid evidence capacity');
    const storage = options.storageDir ? privateStorageDirectory(options.storageDir) : undefined;
    this.storageDir = storage?.path;
    if (this.storageDir) {
      this.initializeDisk();
      this.cleanupPending();
      this.migrateLegacyProvenance();
      this.reconcileProvenance();
      for (const file of readdirSync(this.storageDir).filter(name => orphanTemporaryName.test(name))) {
        const target = join(this.storageDir, file);
        try {
          const info = lstatSync(target);
          if (!info.isFile() || info.isSymbolicLink()) continue;
          const id = file.slice(0, -4);
          if (receiptId.test(id) && this.withProvenanceDb(db => Boolean(
            db.prepare(`SELECT id FROM inflight WHERE id = ?
              UNION SELECT id FROM cleanup_pending WHERE id = ?
              UNION SELECT id FROM receipts WHERE id = ?`).get(id, id, id)))) continue;
          if (this.clock() - info.mtimeMs > 600_000) this.removeFile(target);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  }

  capture(input: EvidenceCapture): EvidenceReceipt {
    if (this.storageDir) this.cleanupPending();
    if (input.source.kind === 'research') {
      if (input.source.untrusted !== true) throw new Error('Research evidence must be marked untrusted');
      if (!this.storageDir) for (const entry of this.entries.values()) {
        const prior = entry.receipt.source;
        if (entry.receipt.expiresAt > this.clock() && prior.kind === 'research'
          && sameResearchSource(prior, input.source))
          throw new Error('Duplicate research provenance');
      }
    }
    let canonicalPath: string | undefined;
    let sourceHash: string | undefined;
    if (input.source.kind === 'workspace') {
      canonicalPath = canonicalWorkspace(input.source.root, input.source.path);
      const info = statSync(canonicalPath);
      if (!info.isFile() || info.size > MAX_CAPTURE) throw new Error('Invalid workspace file');
      sourceHash = hash(input.bytes);
    }
    if (input.source.kind === 'derived_workspace') canonicalWorkspace(input.source.root, input.source.path);
    const sanitized = redactKnownSecrets(input.bytes);
    const bytes = Buffer.from(sanitized.bytes.subarray(0, MAX_CAPTURE));
    if (bytes.length > this.maxTotalBytes) throw new RangeError('Evidence capture exceeds total capacity');
    if (input.source.kind === 'workspace') {
      for (const entry of this.entries.values()) {
        const prior = entry.receipt;
        if (entry.canonicalPath !== canonicalPath || entry.sourceHash !== sourceHash || prior.expiresAt <= this.clock()
          || prior.redacted !== Boolean(input.redacted || sanitized.redacted)
          || prior.truncated !== Boolean(input.truncated || sanitized.bytes.length > MAX_CAPTURE)
          || prior.originalBytes !== (input.originalBytes === null ? null : input.originalBytes ?? input.bytes.length)
          || !entry.bytes.equals(bytes)) continue;
        // Another process may have evicted the persisted receipt; revalidate before reuse.
        if (this.storageDir) {
          const active = this.withProvenanceDb(db => db.prepare('SELECT id, sha256, storedBytes, expiresAt FROM receipts WHERE id = ?').get(prior.id)) as ReceiptRow | undefined;
          if (!active || active.sha256 !== prior.sha256 || active.expiresAt !== prior.expiresAt || !existsSync(join(this.storageDir, `${prior.id}.json`))) continue;
        }
        return structuredClone(prior);
      }
    }
    const receipt: EvidenceReceipt = {
      id: randomUUID(), sha256: hash(bytes), storedBytes: bytes.length,
      originalBytes: input.originalBytes === null ? null : input.originalBytes ?? input.bytes.length,
      redacted: Boolean(input.redacted || sanitized.redacted), truncated: Boolean(input.truncated || sanitized.bytes.length > MAX_CAPTURE),
      expiresAt: this.clock() + 600_000, source: structuredClone(input.source),
    };
    const entry = { receipt, bytes, sourceHash, canonicalPath, order: ++this.nextOrder };
    if (this.storageDir) {
      this.reserveDiskReceipt(receipt);
      const file = join(this.storageDir, receipt.id + '.json');
      const temporary = join(this.storageDir, receipt.id + '.tmp');
      try {
        writeFileSync(temporary, JSON.stringify({ ...entry, bytes: bytes.toString('base64') }), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
        this.commitDiskReceipt(receipt);
        if (input.source.kind === 'research') this.assertResearchClaimCurrent(input.source, receipt);
      } catch (error) {
        try { this.abandonReceipt(receipt); } catch { /* Durable pending cleanup is retried on the next operation. */ }
        throw error;
      }
    }
    this.entries.set(receipt.id, entry);
    if (!this.storageDir) this.enforceCapacity(); else this.trimMemoryCache();
    return structuredClone(receipt);
  }

  private withProvenanceDb<T>(work: (db: Database) => T): T {
    const db = new Database(join(this.storageDir!, 'research-provenance.sqlite'));
    try {
      db.pragma('busy_timeout = 5000');
      db.exec('CREATE TABLE IF NOT EXISTS provenance (key TEXT PRIMARY KEY, id TEXT NOT NULL, sha256 TEXT NOT NULL, expiresAt INTEGER NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS receipts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, storedBytes INTEGER NOT NULL, expiresAt INTEGER NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS cleanup_pending (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, storedBytes INTEGER NOT NULL, expiresAt INTEGER NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS inflight (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, storedBytes INTEGER NOT NULL, expiresAt INTEGER NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS cache_state (name TEXT PRIMARY KEY)');
      return work(db);
    } finally { db.close(); }
  }

  private validateReceiptRow(row: ReceiptRow): void {
    if (!receiptId.test(row.id) || !/^[a-f0-9]{64}$/.test(row.sha256)
      || !Number.isSafeInteger(row.storedBytes) || row.storedBytes < 0 || row.storedBytes > MAX_CAPTURE
      || !Number.isSafeInteger(row.expiresAt) || !Number.isSafeInteger(row.sequence) || row.sequence < 1)
      throw new Error('Evidence receipt metadata corrupt');
  }

  private assertUniqueDiskGeneration(db: Database): void {
    // Capture IDs are generated internally with randomUUID. A repeated ID across lifecycle
    // tables is an impossible API state; preserve every claim rather than guessing ownership.
    const collision = db.prepare(`SELECT id FROM (
      SELECT id FROM receipts UNION ALL SELECT id FROM inflight UNION ALL SELECT id FROM cleanup_pending
    ) GROUP BY id HAVING count(*) > 1 LIMIT 1`).get();
    if (collision) throw new Error('Evidence receipt generation collision');
  }

  private readDiskEntry(id: string, row?: ReceiptRow, extension: 'json' | 'tmp' = 'json'): Entry {
    if (!receiptId.test(id)) throw new Error('Invalid evidence receipt ID');
    const file = join(this.storageDir!, id + '.' + extension);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DISK_FILE
      || process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()))
      throw new Error('Unsafe evidence file');
    const disk: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!validDiskEntry(disk, id)) throw new Error('Invalid evidence metadata');
    const bytes = Buffer.from(disk.bytes, 'base64');
    if (bytes.length !== disk.receipt.storedBytes || hash(bytes) !== disk.receipt.sha256
      || row && (row.sha256 !== disk.receipt.sha256 || row.storedBytes !== bytes.length || row.expiresAt !== disk.receipt.expiresAt))
      throw new Error('Corrupt evidence receipt');
    return { receipt: disk.receipt, bytes, sourceHash: disk.sourceHash, canonicalPath: disk.canonicalPath,
      order: row?.sequence ?? disk.order ?? info.mtimeMs };
  }

  private removeReceiptRows(db: Database, ids: string[]): void {
    for (const id of ids) {
      db.prepare('INSERT INTO cleanup_pending (id, sha256, storedBytes, expiresAt) SELECT id, sha256, storedBytes, expiresAt FROM receipts WHERE id = ?').run(id);
      db.prepare('DELETE FROM provenance WHERE id = ?').run(id);
      db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
    }
  }

  private abandonReceipt(receipt: EvidenceReceipt): void {
    this.withProvenanceDb(db => db.transaction(() => {
      this.assertUniqueDiskGeneration(db);
      db.prepare('DELETE FROM inflight WHERE id = ? AND sha256 = ? AND expiresAt = ?')
        .run(receipt.id, receipt.sha256, receipt.expiresAt);
      const active = db.prepare('SELECT sha256, expiresAt FROM receipts WHERE id = ?')
        .get(receipt.id) as Pick<ReceiptRow, 'sha256' | 'expiresAt'> | undefined;
      if (active && (active.sha256 !== receipt.sha256 || active.expiresAt !== receipt.expiresAt))
        throw new Error('Evidence receipt generation collision');
      if (active) this.removeReceiptRows(db, [receipt.id]);
      else {
        for (const extension of ['json', 'tmp'] as const) {
          const path = join(this.storageDir!, `${receipt.id}.${extension}`);
          if (existsSync(path)) {
            const disk = this.readDiskEntry(receipt.id, undefined, extension);
            if (disk.receipt.sha256 === receipt.sha256 && disk.receipt.expiresAt === receipt.expiresAt)
              db.prepare('INSERT INTO cleanup_pending (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
                .run(receipt.id, receipt.sha256, receipt.storedBytes, receipt.expiresAt);
          }
        }
      }
    }).immediate());
    this.entries.delete(receipt.id);
    this.cleanupPending();
  }

  private cleanupPending(): void {
    if (!this.storageDir) return;
    const morePending = this.withProvenanceDb(db => db.transaction(() => {
      this.assertUniqueDiskGeneration(db);
      const stale = db.prepare('SELECT id, sha256, storedBytes, expiresAt FROM inflight WHERE expiresAt <= ? LIMIT 128')
        .all(this.clock()) as Array<Pick<ReceiptRow, 'id' | 'sha256' | 'storedBytes' | 'expiresAt'>>;
      for (const row of stale) {
        db.prepare('INSERT INTO cleanup_pending (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
          .run(row.id, row.sha256, row.storedBytes, row.expiresAt);
        db.prepare('DELETE FROM inflight WHERE id = ?').run(row.id);
      }
      const pending = db.prepare('SELECT id, sha256, storedBytes, expiresAt FROM cleanup_pending ORDER BY expiresAt, id LIMIT 128')
        .all() as Array<Pick<ReceiptRow, 'id' | 'sha256' | 'storedBytes' | 'expiresAt'>>;
      for (const row of pending) {
        if (!receiptId.test(row.id) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Evidence cleanup metadata corrupt');
        const active = db.prepare('SELECT id FROM receipts WHERE id = ?').get(row.id);
        if (!active) {
          for (const extension of ['json', 'tmp'] as const) {
            const path = join(this.storageDir!, `${row.id}.${extension}`);
            try {
              if (existsSync(path)) {
                let replacement = false;
                try {
                  const disk = this.readDiskEntry(row.id, undefined, extension);
                  replacement = disk.receipt.sha256 !== row.sha256 || disk.receipt.expiresAt !== row.expiresAt;
                } catch { /* An invalid unindexed file cannot become trusted evidence. */ }
                if (!replacement) this.removeFile(path);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Evidence bounded storage cleanup failed', { cause: error });
            }
          }
        }
        db.prepare('DELETE FROM cleanup_pending WHERE id = ?').run(row.id);
        this.entries.delete(row.id);
      }
      return Boolean(db.prepare('SELECT id FROM cleanup_pending LIMIT 1').get());
    }).immediate());
    if (morePending) throw new Error('Evidence bounded storage cleanup requires another sweep');
  }

  private reserveDiskReceipt(receipt: EvidenceReceipt): void {
    const removed = this.withProvenanceDb(db => db.transaction(() => {
      this.assertUniqueDiskGeneration(db);
      if (db.prepare(`SELECT id FROM (
        SELECT id FROM receipts UNION ALL SELECT id FROM inflight UNION ALL SELECT id FROM cleanup_pending
      ) WHERE id = ? LIMIT 1`).get(receipt.id)) throw new Error('Evidence receipt ID collision');
      if (db.prepare('SELECT id FROM cleanup_pending LIMIT 1').get())
        throw new Error('Evidence bounded storage cleanup is pending');
      if (receipt.source.kind === 'research') {
        const prior = db.prepare('SELECT key, id, sha256, expiresAt FROM provenance WHERE key = ?')
          .get(researchKey(receipt.source)) as ProvenanceRow | undefined;
        if (prior) { this.validateProvenance(prior); if (this.liveProvenance(prior)) throw new Error('Duplicate research provenance'); }
      }
      const inflight = db.prepare('SELECT count(*) AS count, COALESCE(sum(storedBytes), 0) AS bytes FROM inflight')
        .get() as { count: number; bytes: number };
      if (inflight.count + 1 > this.maxEntries || inflight.bytes + receipt.storedBytes > this.maxTotalBytes)
        throw new Error('Evidence bounded storage admission is full');
      const active = db.prepare('SELECT sequence, id, sha256, storedBytes, expiresAt FROM receipts ORDER BY sequence, id')
        .all() as ReceiptRow[];
      let count = active.length + inflight.count + 1;
      let bytes = active.reduce((sum, row) => sum + row.storedBytes, 0) + inflight.bytes + receipt.storedBytes;
      const evicted: string[] = [];
      for (const row of active) {
        if (row.expiresAt > this.clock() && count <= this.maxEntries && bytes <= this.maxTotalBytes) break;
        this.validateReceiptRow(row);
        this.removeReceiptRows(db, [row.id]);
        evicted.push(row.id);
        count--; bytes -= row.storedBytes;
      }
      return evicted;
    }).immediate());
    this.removeReceiptFiles(removed);
    this.withProvenanceDb(db => db.transaction(() => {
      this.assertUniqueDiskGeneration(db);
      if (db.prepare(`SELECT id FROM (
        SELECT id FROM receipts UNION ALL SELECT id FROM inflight UNION ALL SELECT id FROM cleanup_pending
      ) WHERE id = ? LIMIT 1`).get(receipt.id)) throw new Error('Evidence receipt ID collision');
      if (db.prepare('SELECT id FROM cleanup_pending LIMIT 1').get())
        throw new Error('Evidence bounded storage cleanup is pending');
      const totals = db.prepare(`SELECT
        (SELECT count(*) FROM receipts) + (SELECT count(*) FROM inflight) AS count,
        (SELECT COALESCE(sum(storedBytes), 0) FROM receipts) +
        (SELECT COALESCE(sum(storedBytes), 0) FROM inflight) AS bytes`).get() as { count: number; bytes: number };
      if (totals.count + 1 > this.maxEntries || totals.bytes + receipt.storedBytes > this.maxTotalBytes)
        throw new Error('Evidence bounded storage admission is full');
      if (receipt.source.kind === 'research') {
        const prior = db.prepare('SELECT key, id, sha256, expiresAt FROM provenance WHERE key = ?')
          .get(researchKey(receipt.source)) as ProvenanceRow | undefined;
        if (prior) { this.validateProvenance(prior); if (this.liveProvenance(prior)) throw new Error('Duplicate research provenance'); }
      }
      db.prepare('INSERT INTO inflight (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
        .run(receipt.id, receipt.sha256, receipt.storedBytes, receipt.expiresAt);
    }).immediate());
  }

  private pruneDiskRows(db: Database): string[] {
    const removed: string[] = [];
    const expired = db.prepare('SELECT sequence, id, sha256, storedBytes, expiresAt FROM receipts WHERE expiresAt <= ?')
      .all(this.clock()) as ReceiptRow[];
    for (const row of expired) this.validateReceiptRow(row);
    removed.push(...expired.map(row => row.id));
    this.removeReceiptRows(db, removed);
    db.prepare('DELETE FROM provenance WHERE expiresAt <= ?').run(this.clock());
    while (true) {
      const totals = db.prepare('SELECT count(*) AS count, COALESCE(sum(storedBytes), 0) AS bytes FROM receipts')
        .get() as { count: number; bytes: number };
      if (totals.count <= this.maxEntries && totals.bytes <= this.maxTotalBytes) break;
      const oldest = db.prepare('SELECT sequence, id, sha256, storedBytes, expiresAt FROM receipts ORDER BY sequence, id LIMIT 1')
        .get() as ReceiptRow;
      this.validateReceiptRow(oldest);
      this.removeReceiptRows(db, [oldest.id]);
      removed.push(oldest.id);
    }
    return removed;
  }

  private removeReceiptFiles(ids: string[]): void {
    for (const id of ids) {
      if (!receiptId.test(id)) throw new Error('Invalid evidence cleanup path');
      const known = this.entries.get(id);
      this.entries.delete(id);
      this.withProvenanceDb(db => db.transaction(() => {
        if (db.prepare('SELECT id FROM receipts WHERE id = ?').get(id)) return;
        const pending = db.prepare('SELECT id FROM cleanup_pending WHERE id = ?').get(id);
        if (pending) return;
        const path = join(this.storageDir!, id + '.json');
        if (existsSync(path)) {
          try {
            const disk = this.readDiskEntry(id);
            if (!known || disk.receipt.sha256 !== known.receipt.sha256
              || disk.receipt.expiresAt !== known.receipt.expiresAt) return;
          } catch { /* Invalid unindexed files are safe to discard. */ }
        }
        try { this.removeFile(path); }
        catch (error) { throw new Error('Evidence bounded storage cleanup failed', { cause: error }); }
      }).immediate());
    }
    this.cleanupPending();
  }

  private initializeDisk(): void {
    const removed = this.withProvenanceDb(db => db.transaction(() => {
      this.assertUniqueDiskGeneration(db);
      const cleanup: string[] = [];
      if (!db.prepare("SELECT name FROM cache_state WHERE name = 'receipts-initialized'").get()) {
        const candidates: Entry[] = [];
        for (const file of readdirSync(this.storageDir!).filter(name => receiptFileName.test(name))) {
          const id = file.slice(0, -5);
          if (!receiptId.test(id)) continue;
          try {
            const entry = this.readDiskEntry(id);
            if (entry.receipt.expiresAt <= this.clock()) cleanup.push(id);
            else candidates.push(entry);
          } catch { cleanup.push(id); }
        }
        candidates.sort((a, b) => a.order - b.order || a.receipt.id.localeCompare(b.receipt.id));
        for (const entry of candidates) db.prepare('INSERT INTO receipts (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
          .run(entry.receipt.id, entry.receipt.sha256, entry.receipt.storedBytes, entry.receipt.expiresAt);
        db.prepare("INSERT INTO cache_state (name) VALUES ('receipts-initialized')").run();
      }
      const rows = db.prepare('SELECT sequence, id, sha256, storedBytes, expiresAt FROM receipts ORDER BY sequence, id')
        .all() as ReceiptRow[];
      for (const row of rows) {
        this.validateReceiptRow(row);
        if (row.expiresAt <= this.clock()) continue;
        try { this.entries.set(row.id, this.readDiskEntry(row.id, row)); }
        catch { this.removeReceiptRows(db, [row.id]); cleanup.push(row.id); }
      }
      cleanup.push(...this.pruneDiskRows(db));
      return cleanup;
    }).immediate());
    this.removeReceiptFiles(removed);
    // Receipt files from a crash before the database commit have no live row.
    this.withProvenanceDb(db => db.transaction(() => {
      for (const file of readdirSync(this.storageDir!).filter(name => receiptFileName.test(name))) {
        const id = file.slice(0, -5);
        if (!receiptId.test(id) || db.prepare('SELECT id FROM receipts WHERE id = ?').get(id)) continue;
        let expired = false;
        try { expired = this.readDiskEntry(id).receipt.expiresAt <= this.clock(); }
        catch { expired = true; }
        if (expired) rmSync(join(this.storageDir!, file), { force: true });
      }
    }).immediate());
  }

  private commitDiskReceipt(receipt: EvidenceReceipt): void {
    const removed = this.withProvenanceDb(db => db.transaction(() => {
      this.assertUniqueDiskGeneration(db);
      const reservation = db.prepare('SELECT id, sha256, storedBytes, expiresAt FROM inflight WHERE id = ?')
        .get(receipt.id) as Pick<ReceiptRow, 'id' | 'sha256' | 'storedBytes' | 'expiresAt'> | undefined;
      if (!reservation || reservation.sha256 !== receipt.sha256 || reservation.storedBytes !== receipt.storedBytes
        || reservation.expiresAt !== receipt.expiresAt || db.prepare('SELECT id FROM cleanup_pending LIMIT 1').get())
        throw new Error('Evidence bounded storage admission expired or cleanup is pending');
      const cleanup = this.pruneDiskRows(db);
      if (receipt.expiresAt <= this.clock() || !existsSync(join(this.storageDir!, receipt.id + '.json')))
        throw new Error('Evidence receipt expired or evicted before claim');
      if (receipt.source.kind === 'research') {
        const key = researchKey(receipt.source);
        const prior = db.prepare('SELECT key, id, sha256, expiresAt FROM provenance WHERE key = ?').get(key) as ProvenanceRow | undefined;
        if (prior) {
          this.validateProvenance(prior);
          const previous = db.prepare('SELECT sequence, id, sha256, storedBytes, expiresAt FROM receipts WHERE id = ?')
            .get(prior.id) as ReceiptRow | undefined;
          if (previous) {
            this.validateReceiptRow(previous);
            if (previous.sha256 !== prior.sha256 || previous.expiresAt !== prior.expiresAt)
              throw new Error('Research provenance marker corrupt');
            if (this.liveProvenance(prior)) throw new Error('Duplicate research provenance');
            this.removeReceiptRows(db, [prior.id]);
            cleanup.push(prior.id);
          }
          db.prepare('DELETE FROM provenance WHERE key = ? AND id = ?').run(key, prior.id);
        }
      }
      db.prepare('INSERT INTO receipts (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
        .run(receipt.id, receipt.sha256, receipt.storedBytes, receipt.expiresAt);
      if (receipt.source.kind === 'research') db.prepare('INSERT INTO provenance (key, id, sha256, expiresAt) VALUES (?, ?, ?, ?)')
        .run(researchKey(receipt.source), receipt.id, receipt.sha256, receipt.expiresAt);
      db.prepare('DELETE FROM inflight WHERE id = ?').run(receipt.id);
      cleanup.push(...this.pruneDiskRows(db));
      return cleanup;
    }).immediate());
    this.removeReceiptFiles(removed);
  }

  private assertResearchClaimCurrent(source: ResearchSource, receipt: EvidenceReceipt): void {
    const key = researchKey(source);
    this.withProvenanceDb(db => db.transaction(() => {
      const row = db.prepare('SELECT key, id, sha256, expiresAt FROM provenance WHERE key = ?').get(key) as ProvenanceRow | undefined;
      const indexed = db.prepare('SELECT id FROM receipts WHERE id = ? AND sha256 = ? AND expiresAt = ?').get(receipt.id, receipt.sha256, receipt.expiresAt);
      if (!row || row.id !== receipt.id || row.sha256 !== receipt.sha256
        || row.expiresAt !== receipt.expiresAt || !indexed || !this.liveProvenance(row))
        throw new Error('Research receipt expired or replaced before return');
    }).immediate());
  }

  private validateProvenance(row: ProvenanceRow): void {
    if (!/^[a-f0-9]{64}$/.test(row.key) || !receiptId.test(row.id)
      || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.expiresAt))
      throw new Error('Research provenance marker corrupt');
  }

  private liveProvenance(row: ProvenanceRow): boolean {
    if (row.expiresAt <= this.clock()) return false;
    const file = join(this.storageDir!, row.id + '.json');
    let info;
    try { info = lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DISK_FILE)
      throw new Error('Research provenance marker corrupt');
    let disk: unknown;
    try { disk = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('Research provenance marker corrupt'); }
    if (!validDiskEntry(disk, row.id) || disk.receipt.source.kind !== 'research'
      || researchKey(disk.receipt.source) !== row.key || disk.receipt.sha256 !== row.sha256
      || disk.receipt.expiresAt !== row.expiresAt)
      throw new Error('Research provenance marker corrupt');
    const bytes = Buffer.from(disk.bytes, 'base64');
    if (bytes.length !== disk.receipt.storedBytes || hash(bytes) !== row.sha256)
      throw new Error('Research provenance marker corrupt');
    return true;
  }

  private migrateLegacyProvenance(): void {
    for (const file of readdirSync(this.storageDir!).filter(name => provenanceFileName.test(name))) {
      const marker = join(this.storageDir!, file);
      const info = lstatSync(marker);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512)
        throw new Error('Research provenance marker corrupt');
      let legacy: unknown;
      try { legacy = JSON.parse(readFileSync(marker, 'utf8')); }
      catch { throw new Error('Research provenance marker corrupt'); }
      if (!legacy || typeof legacy !== 'object') throw new Error('Research provenance marker corrupt');
      const value = legacy as Record<string, unknown>;
      const row = { key: value.key, id: value.id, sha256: value.sha256, expiresAt: value.expiresAt } as ProvenanceRow;
      this.validateProvenance(row);
      if (value.version !== 1 || file !== `.research-provenance-${row.key}.json`)
        throw new Error('Research provenance marker corrupt');
      if (row.expiresAt <= this.clock() || !this.entries.has(row.id)) { rmSync(marker, { force: true }); continue; }
      const receipt = this.entries.get(row.id)!.receipt;
      if (receipt.sha256 !== row.sha256 || receipt.expiresAt !== row.expiresAt
        || receipt.source.kind !== 'research' || researchKey(receipt.source) !== row.key)
        throw new Error('Research provenance marker corrupt');
      this.withProvenanceDb(db => db.transaction(() => {
        const prior = db.prepare('SELECT key, id, sha256, expiresAt FROM provenance WHERE key = ?').get(row.key) as ProvenanceRow | undefined;
        if (prior) {
          this.validateProvenance(prior);
          if (prior.id !== row.id && this.liveProvenance(prior))
            throw new Error('Duplicate research provenance');
        }
        db.prepare('INSERT OR REPLACE INTO provenance (key, id, sha256, expiresAt) VALUES (?, ?, ?, ?)')
          .run(row.key, row.id, row.sha256, row.expiresAt);
      }).immediate());
      rmSync(marker, { force: true });
    }
  }

  private reconcileProvenance(): void {
    this.withProvenanceDb(db => db.transaction(() => {
      const rows = db.prepare('SELECT key, id, sha256, expiresAt FROM provenance').all() as ProvenanceRow[];
      for (const row of rows) {
        this.validateProvenance(row);
        const indexed = db.prepare('SELECT id FROM receipts WHERE id = ? AND sha256 = ? AND expiresAt = ?')
          .get(row.id, row.sha256, row.expiresAt);
        if (!indexed || !this.liveProvenance(row))
          db.prepare('DELETE FROM provenance WHERE key = ? AND id = ?').run(row.key, row.id);
      }
    }).immediate());
  }

  async expand(input: { id: string; startByte?: number; maxBytes?: number; expectedSha256?: string }): Promise<EvidencePage> {
    if (this.storageDir) this.cleanupPending();
    let entry = this.entries.get(input.id);
    if (this.storageDir) {
      const row = this.withProvenanceDb(db => db.prepare('SELECT sequence, id, sha256, storedBytes, expiresAt FROM receipts WHERE id = ?')
        .get(input.id) as ReceiptRow | undefined);
      if (!row) {
        if (entry && receiptId.test(input.id)) this.removeReceiptFiles([input.id]);
        else this.entries.delete(input.id);
        return { status: entry && entry.receipt.expiresAt <= this.clock() ? 'expired' : 'missing', id: input.id };
      }
      this.validateReceiptRow(row);
      if (row.expiresAt <= this.clock()) { this.delete(input.id); return { status: 'expired', id: input.id }; }
      if (!entry || entry.receipt.sha256 !== row.sha256 || entry.receipt.expiresAt !== row.expiresAt) {
        try { entry = this.readDiskEntry(input.id, row); this.entries.set(input.id, entry); this.trimMemoryCache(); }
        catch { this.delete(input.id); return { status: 'missing', id: input.id }; }
      }
    }
    if (!entry) return { status: 'missing', id: input.id };
    if (entry.receipt.expiresAt <= this.clock()) { this.delete(input.id); return { status: 'expired', id: input.id }; }
    if (this.storageDir && !existsSync(join(this.storageDir, input.id + '.json'))) {
      this.delete(input.id);
      return { status: 'missing', id: input.id };
    }
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== entry.receipt.sha256)
      return { status: 'hash_mismatch', id: input.id };
    const startByte = input.startByte ?? 0;
    const maxBytes = input.maxBytes ?? DEFAULT_PAGE;
    if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte > entry.bytes.length ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE) throw new RangeError('Invalid evidence byte range');
    const end = Math.min(entry.bytes.length, startByte + maxBytes);
    let status: 'ok' | 'stale' = 'ok';
    if (entry.receipt.source.kind === 'workspace') {
      try {
        const actual = canonicalWorkspace(entry.receipt.source.root, entry.receipt.source.path);
        if (actual !== entry.canonicalPath || hash(await safeWorkspaceBytes(entry.receipt.source.root, actual)) !== entry.sourceHash) status = 'stale';
      } catch { status = 'stale'; }
    }
    return { status, receipt: structuredClone(entry.receipt), startByte, nextByte: end < entry.bytes.length ? end : null,
      dataBase64: entry.bytes.subarray(startByte, end).toString('base64') };
  }

  private delete(id: string): void {
    if (this.storageDir) {
      if (!receiptId.test(id)) throw new Error('Invalid evidence receipt ID');
      this.withProvenanceDb(db => db.transaction(() => this.removeReceiptRows(db, [id])).immediate());
      this.removeReceiptFiles([id]);
    }
    this.entries.delete(id);
  }

  // Disk mode: the receipts index is authoritative and expand() rereads files, so memory
  // is only a cache. Bound it so a long-lived server cannot keep buffers for receipts
  // that other processes already evicted.
  private trimMemoryCache(): void {
    const now = this.clock();
    let total = 0;
    for (const [id, entry] of this.entries) {
      if (entry.receipt.expiresAt <= now) this.entries.delete(id);
      else total += entry.bytes.length;
    }
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && total <= this.maxTotalBytes) break;
      this.entries.delete(id);
      total -= entry.bytes.length;
    }
  }

  private enforceCapacity(): void {
    for (const [id, entry] of this.entries) if (entry.receipt.expiresAt <= this.clock()) this.delete(id);
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes.length, 0);
    while (this.entries.size > this.maxEntries || total > this.maxTotalBytes) {
      const oldest = this.entries.keys().next().value as string;
      total -= this.entries.get(oldest)!.bytes.length;
      this.delete(oldest);
    }
  }
}
