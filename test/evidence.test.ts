import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EvidenceStore } from '../src/evidence.js';
import { Database } from '../src/sqlite.js';

const command = { kind: 'command' as const, cwd: process.cwd(), argv: ['node', '-e', ''], channel: 'stdout' as const };

test('unchanged workspace captures reuse a live receipt while commands are never replayed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion source reuse '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'file.txt');
  await writeFile(path, 'original\n');
  const source = { kind: 'workspace' as const, root, path: 'file.txt' };
  const store = new EvidenceStore();
  const first = store.capture({ source, bytes: Buffer.from('original\n') });
  const unchanged = store.capture({ source, bytes: Buffer.from('original\n') });
  assert.equal(unchanged.id, first.id);
  await writeFile(path, 'changed\n');
  const changed = store.capture({ source, bytes: Buffer.from('changed\n') });
  assert.notEqual(changed.id, first.id);
  assert.equal((await store.expand({ id: first.id })).status, 'stale');
  const command1 = store.capture({ source: command, bytes: Buffer.from('same') });
  const command2 = store.capture({ source: command, bytes: Buffer.from('same') });
  assert.notEqual(command1.id, command2.id);
});

test('evidence expands a long Unicode line exactly across byte pages', async () => {
  const original = Buffer.from('🔬 café 漢字'.repeat(5000));
  const store = new EvidenceStore();
  const receipt = store.capture({ source: command, bytes: original });
  original.fill(0);
  let next = 0;
  const chunks: Buffer[] = [];
  do {
    const page = await store.expand({ id: receipt.id, startByte: next, maxBytes: 16385, expectedSha256: receipt.sha256 });
    assert.equal(page.status, 'ok');
    if (page.status !== 'ok') throw new Error('missing page');
    chunks.push(Buffer.from(page.dataBase64, 'base64'));
    next = page.nextByte ?? -1;
  } while (next >= 0);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from('🔬 café 漢字'.repeat(5000)));
  assert.equal(receipt.originalBytes, Buffer.byteLength('🔬 café 漢字'.repeat(5000)));
  assert.equal((await store.expand({ id: receipt.id, expectedSha256: 'wrong' })).status, 'hash_mismatch');
});

test('file mutation marks snapshot stale while preserving captured bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'before');
  const store = new EvidenceStore();
  const receipt = store.capture({ source: { kind: 'workspace', root, path: 'a.txt' }, bytes: Buffer.from('before') });
  await writeFile(join(root, 'a.txt'), 'after');
  const page = await store.expand({ id: receipt.id });
  assert.equal(page.status, 'stale');
  if (page.status !== 'stale') throw new Error('expected stale');
  assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), 'before');
});

test('a file changed between snapshot and capture is already stale', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'before');
  const captured = Buffer.from('before');
  await writeFile(join(root, 'a.txt'), 'after');
  const store = new EvidenceStore();
  const receipt = store.capture({ source: { kind: 'workspace', root, path: 'a.txt' }, bytes: captured });
  assert.equal((await store.expand({ id: receipt.id })).status, 'stale');
});

test('expiry and eviction report unavailable status explicitly', async () => {
  let now = 1000;
  const store = new EvidenceStore({ clock: () => now, maxEntries: 1 });
  const first = store.capture({ source: command, bytes: Buffer.from('first') });
  const second = store.capture({ source: command, bytes: Buffer.from('second') });
  assert.equal((await store.expand({ id: first.id })).status, 'missing');
  now += 600_001;
  assert.equal((await store.expand({ id: second.id })).status, 'expired');
});

test('capture caps bytes, preserves unknown length, and labels redaction', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 7, 65);
  const store = new EvidenceStore();
  const receipt = store.capture({ source: command, bytes, originalBytes: null, redacted: true });
  assert.equal(receipt.storedBytes, 8 * 1024 * 1024);
  assert.equal(receipt.originalBytes, null);
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.redacted, true);
  const page = await store.expand({ id: receipt.id, startByte: receipt.storedBytes - 3, maxBytes: 64 });
  assert.equal(page.status, 'ok');
  if (page.status === 'ok') assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), 'AAA');
});

test('known credential lines are redacted and never expand their original bytes', async () => {
  const store = new EvidenceStore();
  const receipt = store.capture({ source: command, bytes: Buffer.from('status=ok\nTEAMOROUTER_API_KEY=topsecret\nAuthorization: Bearer verysecret\n') });
  const page = await store.expand({ id: receipt.id });
  assert.equal(receipt.redacted, true);
  assert.equal(page.status, 'ok');
  if (page.status !== 'ok') throw new Error('missing page');
  const recovered = Buffer.from(page.dataBase64, 'base64').toString();
  assert.match(recovered, /status=ok/);
  assert.doesNotMatch(recovered, /topsecret|verysecret/);
  assert.match(recovered, /\[REDACTED\]/);
});

test('workspace secret paths are excluded from evidence capture', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'secret');
  const store = new EvidenceStore();
  assert.throws(() => store.capture({ source: { kind: 'workspace', root, path: '.env' }, bytes: Buffer.from('secret') }), /path/i);
});

test('private storage persists receipts across store instances', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-evidence-store-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const first = new EvidenceStore({ storageDir });
  const receipt = first.capture({ source: command, bytes: Buffer.from('persisted') });
  const second = new EvidenceStore({ storageDir });
  const page = await second.expand({ id: receipt.id });
  assert.equal(page.status, 'ok');
  if (page.status === 'ok') assert.equal(Buffer.from(page.dataBase64, 'base64').toString(), 'persisted');
});

test('returned receipt mutations cannot change hash, expiry, provenance or staleness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-receipt-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'original');
  let now = 1000;
  const store = new EvidenceStore({ clock: () => now });
  const receipt = store.capture({ source: { kind: 'workspace', root, path: 'note.txt' }, bytes: Buffer.from('original') });
  const hash = receipt.sha256;
  receipt.sha256 = 'forged'; receipt.expiresAt = Number.MAX_SAFE_INTEGER;
  (receipt.source as any).kind = 'command';
  const first = await store.expand({ id: receipt.id, expectedSha256: hash });
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') throw new Error('missing page');
  first.receipt.sha256 = 'other'; first.receipt.expiresAt = Number.MAX_SAFE_INTEGER;
  (first.receipt.source as any).kind = 'command';
  await writeFile(join(root, 'note.txt'), 'changed');
  const stale = await store.expand({ id: receipt.id, expectedSha256: hash });
  assert.equal(stale.status, 'stale');
  if (stale.status === 'stale') assert.equal(stale.receipt.sha256, hash);
  now += 600_001;
  assert.equal((await store.expand({ id: receipt.id })).status, 'expired');
});

test('capacity never returns an already missing receipt and reload cleans expired and excess entries', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-capacity-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  assert.throws(() => new EvidenceStore({ maxTotalBytes: 1 }).capture({ source: command, bytes: Buffer.from('ab') }), /capacity|large/i);
  let now = 1000;
  const firstStore = new EvidenceStore({ storageDir, clock: () => now });
  const first = firstStore.capture({ source: command, bytes: Buffer.from('one') });
  const second = firstStore.capture({ source: command, bytes: Buffer.from('two') });
  const reopened = new EvidenceStore({ storageDir, clock: () => now, maxEntries: 1 });
  assert.equal((await reopened.expand({ id: first.id })).status, 'missing');
  assert.equal((await reopened.expand({ id: second.id })).status, 'ok');
  now += 600_001;
  const expired = new EvidenceStore({ storageDir, clock: () => now });
  assert.equal((await expired.expand({ id: second.id })).status, 'missing');
  assert.deepEqual((await readdir(storageDir)).filter(name => name.endsWith('.json')), []);
});

test('disk capacity also covers command receipts captured by already-open stores', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-command-shared-capacity-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const first = new EvidenceStore({ storageDir, maxEntries: 1 });
  const second = new EvidenceStore({ storageDir, maxEntries: 1 });
  const old = first.capture({ source: command, bytes: Buffer.from('old') });
  const current = second.capture({ source: command, bytes: Buffer.from('new') });
  assert.equal((await first.expand({ id: old.id })).status, 'missing');
  assert.equal((await first.expand({ id: current.id })).status, 'ok');
  assert.deepEqual((await readdir(storageDir)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)), [`${current.id}.json`]);
});

test('stale store cleanup preserves a different in-flight receipt file at the same ID', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-stale-cleanup-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const first = new EvidenceStore({ storageDir, maxEntries: 1 });
  const second = new EvidenceStore({ storageDir, maxEntries: 1 });
  const old = first.capture({ source: command, bytes: Buffer.from('old') });
  const current = second.capture({ source: command, bytes: Buffer.from('new') });
  const candidate = JSON.parse(await readFile(join(storageDir, `${current.id}.json`), 'utf8'));
  candidate.receipt.id = old.id;
  await writeFile(join(storageDir, `${old.id}.json`), JSON.stringify(candidate));
  assert.equal((await first.expand({ id: old.id })).status, 'missing');
  assert.ok((await readdir(storageDir)).includes(`${old.id}.json`));
});

test('failed post-commit eviction stays accounted and a long-lived store retries cleanup after TTL', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-post-commit-cleanup-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  let now = 1_000;
  let blocked = false;
  const store = new EvidenceStore({ storageDir, clock: () => now, maxEntries: 1,
    removeFile: path => {
      if (blocked && path.endsWith('.json')) throw new Error('injected access denial');
      rmSync(path, { force: true });
    },
  });
  const old = store.capture({ source: command, bytes: Buffer.from('old sensitive bytes') });
  blocked = true;
  assert.throws(() => store.capture({ source: command, bytes: Buffer.from('replacement') }), /bounded storage|cleanup failed/i);
  assert.ok((await readdir(storageDir)).includes(`${old.id}.json`));
  const blockedFiles = (await readdir(storageDir)).filter(name => name.endsWith('.json')).length;
  assert.throws(() => store.capture({ source: command, bytes: Buffer.from('another replacement') }), /bounded storage|cleanup failed/i);
  assert.equal((await readdir(storageDir)).filter(name => name.endsWith('.json')).length, blockedFiles);
  const db = new Database(join(storageDir, 'research-provenance.sqlite'));
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM cleanup_pending WHERE id = ?').get(old.id) as { n: number }).n, 1);
  } finally { db.close(); }
  now += 600_001;
  blocked = false;
  const current = store.capture({ source: command, bytes: Buffer.from('current') });
  assert.equal((await store.expand({ id: current.id })).status, 'ok');
  assert.equal((await lstat(join(storageDir, `${old.id}.json`)).catch(() => null)), null);
  const cleaned = new Database(join(storageDir, 'research-provenance.sqlite'));
  try {
    assert.equal((cleaned.prepare('SELECT count(*) AS n FROM cleanup_pending').get() as { n: number }).n, 0);
  } finally { cleaned.close(); }
  const reopened = new EvidenceStore({ storageDir, clock: () => now, maxEntries: 1 });
  assert.equal((await reopened.expand({ id: old.id })).status, 'missing');
});

test('two processes past initial cleanup cannot grow blocked disk captures beyond one candidate', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-concurrent-blocked-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const initial = new EvidenceStore({ storageDir, maxEntries: 1 });
  initial.capture({ source: command, bytes: Buffer.from('old') });
  const gate = join(storageDir, 'release');
  const script = `
import fs from 'node:fs';
const { Database } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/sqlite.ts')).href)});
const { EvidenceStore } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/evidence.ts')).href)});
const store = new EvidenceStore({ storageDir: process.env.FUSION_TEST_STORAGE, maxEntries: 1,
  removeFile: () => { throw new Error('injected access denial'); } });
let pause = true;
const close = Database.prototype.close;
Database.prototype.close = function() {
  close.call(this);
  if (!pause) return;
  pause = false;
  fs.writeFileSync(process.env.FUSION_TEST_READY, 'ready');
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(process.env.FUSION_TEST_GATE)) Atomics.wait(wait, 0, 0, 5);
};
try { store.capture({ source: { kind:'command', cwd:process.cwd(), argv:['node'], channel:'stdout' }, bytes:Buffer.from('new') }); process.stdout.write('CAPTURED\\n'); }
catch (error) { process.stdout.write('ERROR:' + String(error) + '\\n'); }
`;
  const launch = (id: string) => {
    const ready = join(storageDir, `ready-${id}`);
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), env: { ...process.env, FUSION_TEST_STORAGE: storageDir, FUSION_TEST_READY: ready,
        FUSION_TEST_GATE: gate }, windowsHide: true,
    });
    t.after(() => { if (!child.killed) child.kill(); });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    return { ready, done: new Promise<string>((resolve, reject) => child.once('exit', code =>
      code === 0 ? resolve(output) : reject(new Error(errors || output)))) };
  };
  const first = launch('a'), second = launch('b');
  const deadline = Date.now() + 10_000;
  while (!(await readdir(storageDir)).includes('ready-a') || !(await readdir(storageDir)).includes('ready-b')) {
    if (Date.now() > deadline) throw new Error('capture race did not reach the barrier');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await writeFile(gate, 'go');
  const outcomes = await Promise.all([first.done, second.done]);
  assert.ok(outcomes.every(output => /ERROR:.*(?:bounded storage|cleanup failed)/i.test(output)), outcomes.join('\n'));
  assert.equal((await readdir(storageDir)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).length, 1,
    'blocked eviction must leave only the accounted old file');
  const db = new Database(join(storageDir, 'research-provenance.sqlite'), { readonly: true });
  try {
    const accounted = db.prepare(`SELECT
      (SELECT count(*) FROM receipts) + (SELECT count(*) FROM cleanup_pending) + (SELECT count(*) FROM inflight) AS n,
      (SELECT COALESCE(sum(storedBytes), 0) FROM receipts) +
      (SELECT COALESCE(sum(storedBytes), 0) FROM cleanup_pending) +
      (SELECT COALESCE(sum(storedBytes), 0) FROM inflight) AS bytes`).get() as { n: number; bytes: number };
    assert.equal(accounted.n, 1);
    assert.equal(accounted.bytes, 3);
  } finally { db.close(); }
});

test('long-lived stores retain capacity for a crashed pre-rename temporary file until cleanup succeeds', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-crashed-temp-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  let now = 1_000;
  let blocked = false;
  const options = { storageDir, clock: () => now, maxEntries: 1,
    removeFile: (path: string) => {
      if (blocked && path.endsWith('.tmp')) throw new Error('injected temp access denial');
      rmSync(path, { force: true });
    } };
  const first = new EvidenceStore(options);
  const second = new EvidenceStore(options);
  const crashed = first.capture({ source: command, bytes: Buffer.from('sensitive temp bytes') });
  const temporary = join(storageDir, `${crashed.id}.tmp`);
  await rename(join(storageDir, `${crashed.id}.json`), temporary);
  const db = new Database(join(storageDir, 'research-provenance.sqlite'));
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO inflight (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
        .run(crashed.id, crashed.sha256, crashed.storedBytes, crashed.expiresAt);
      db.prepare('DELETE FROM receipts WHERE id = ?').run(crashed.id);
    }).immediate();
  } finally { db.close(); }
  now = crashed.expiresAt + 1;
  blocked = true;
  assert.throws(() => second.capture({ source: command, bytes: Buffer.from('new') }), /bounded storage|cleanup failed/i);
  assert.ok((await readdir(storageDir)).includes(`${crashed.id}.tmp`));
  assert.deepEqual((await readdir(storageDir)).filter(name => /^[a-f0-9-]{36}\.(?:tmp|json)$/.test(name)), [`${crashed.id}.tmp`]);
  const pending = new Database(join(storageDir, 'research-provenance.sqlite'), { readonly: true });
  try {
    assert.deepEqual(pending.prepare(`SELECT count(*) AS n, COALESCE(sum(storedBytes), 0) AS bytes FROM (
      SELECT storedBytes FROM cleanup_pending WHERE id = ?
      UNION ALL SELECT storedBytes FROM inflight WHERE id = ?)`)
      .get(crashed.id, crashed.id), { n: 1, bytes: crashed.storedBytes });
  } finally { pending.close(); }
  blocked = false;
  const current = second.capture({ source: command, bytes: Buffer.from('new') });
  assert.equal((await lstat(temporary).catch(() => null)), null);
  assert.equal((await second.expand({ id: current.id })).status, 'ok');
});

test('startup cleanup preserves an older-mtime temporary file belonging to a newer in-flight generation', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-newer-temp-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  let now = 1_000;
  const first = new EvidenceStore({ storageDir, clock: () => now, maxEntries: 1 });
  const old = first.capture({ source: command, bytes: Buffer.from('old') });
  const temporary = join(storageDir, `${old.id}.tmp`);
  const newerBytes = Buffer.from('newer sensitive temp');
  const newerHash = createHash('sha256').update(newerBytes).digest('hex');
  const newerExpiry = old.expiresAt + 600_000;
  const disk = JSON.parse(await readFile(join(storageDir, `${old.id}.json`), 'utf8'));
  disk.receipt.sha256 = newerHash;
  disk.receipt.storedBytes = newerBytes.length;
  disk.receipt.expiresAt = newerExpiry;
  disk.bytes = newerBytes.toString('base64');
  await rename(join(storageDir, `${old.id}.json`), temporary);
  await writeFile(temporary, JSON.stringify(disk));
  await utimes(temporary, new Date(0), new Date(0));
  const db = new Database(join(storageDir, 'research-provenance.sqlite'));
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO cleanup_pending (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
        .run(old.id, old.sha256, old.storedBytes, old.expiresAt);
      db.prepare('DELETE FROM receipts WHERE id = ?').run(old.id);
      db.prepare('INSERT INTO inflight (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
        .run(old.id, newerHash, newerBytes.length, newerExpiry);
    }).immediate();
  } finally { db.close(); }
  now = old.expiresAt + 1;
  assert.throws(() => new EvidenceStore({ storageDir, clock: () => now, maxEntries: 1 }), /generation collision/i);
  assert.ok((await readdir(storageDir)).includes(`${old.id}.tmp`));
  const retained = new Database(join(storageDir, 'research-provenance.sqlite'), { readonly: true });
  try {
    assert.equal((retained.prepare('SELECT count(*) AS n FROM cleanup_pending WHERE id = ?').get(old.id) as { n: number }).n, 1);
    assert.equal((retained.prepare('SELECT count(*) AS n FROM inflight WHERE id = ?').get(old.id) as { n: number }).n, 1);
  } finally { retained.close(); }
});

for (const partial of [false, true]) test(`same-ID expired generations retain ${partial ? 'partial' : 'complete'} newer temporary bytes and both claims`, async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-generation-collision-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  let now = 1_000;
  const store = new EvidenceStore({ storageDir, clock: () => now, maxEntries: 1 });
  const old = store.capture({ source: command, bytes: Buffer.from('old') });
  const temporary = join(storageDir, `${old.id}.tmp`);
  await rename(join(storageDir, `${old.id}.json`), temporary);
  const newerBytes = Buffer.from('newer sensitive temp');
  const newerHash = createHash('sha256').update(newerBytes).digest('hex');
  const newerExpiry = old.expiresAt + 1;
  if (partial) await writeFile(temporary, '{"receipt":');
  else {
    const disk = JSON.parse(await readFile(temporary, 'utf8'));
    disk.receipt.sha256 = newerHash;
    disk.receipt.storedBytes = newerBytes.length;
    disk.receipt.expiresAt = newerExpiry;
    disk.bytes = newerBytes.toString('base64');
    await writeFile(temporary, JSON.stringify(disk));
  }
  const before = await readFile(temporary);
  const db = new Database(join(storageDir, 'research-provenance.sqlite'));
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM receipts WHERE id = ?').run(old.id);
      db.prepare('INSERT INTO cleanup_pending (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
        .run(old.id, old.sha256, old.storedBytes, old.expiresAt);
      db.prepare('INSERT INTO inflight (id, sha256, storedBytes, expiresAt) VALUES (?, ?, ?, ?)')
        .run(old.id, newerHash, newerBytes.length, newerExpiry);
    }).immediate();
  } finally { db.close(); }
  now = newerExpiry + 1;
  assert.throws(() => store.capture({ source: command, bytes: Buffer.from('candidate') }), /generation|collision|bounded storage/i);
  assert.deepEqual(await readFile(temporary), before, 'the newer temporary bytes must not be deleted');
  const retained = new Database(join(storageDir, 'research-provenance.sqlite'), { readonly: true });
  try {
    assert.equal((retained.prepare('SELECT count(*) AS n FROM cleanup_pending WHERE id = ?').get(old.id) as { n: number }).n, 1);
    assert.equal((retained.prepare('SELECT count(*) AS n FROM inflight WHERE id = ?').get(old.id) as { n: number }).n, 1);
  } finally { retained.close(); }
  assert.deepEqual((await readdir(storageDir)).filter(name => /^[a-f0-9-]{36}\.(?:json|tmp)$/.test(name)), [`${old.id}.tmp`]);
});

test('persisted evidence rejects unsafe directory and forged or oversized receipt files', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-storage-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  if (process.platform !== 'win32') {
    await chmod(storageDir, 0o777);
    assert.throws(() => new EvidenceStore({ storageDir }), /private|permission/i);
    await chmod(storageDir, 0o700);
  } else {
    const grant = spawnSync('icacls', [storageDir, '/grant', '*S-1-1-0:(OI)(CI)R'], { encoding: 'utf8' });
    assert.equal(grant.status, 0, grant.stderr);
    new EvidenceStore({ storageDir });
    const acl = spawnSync('icacls', [storageDir], { encoding: 'utf8' });
    assert.equal(acl.status, 0, acl.stderr);
    assert.doesNotMatch(acl.stdout, /Everyone|S-1-1-0/i);
  }
  const store = new EvidenceStore({ storageDir });
  const receipt = store.capture({ source: command, bytes: Buffer.from('safe') });
  const file = join(storageDir, receipt.id + '.json');
  const forged = JSON.parse(await readFile(file, 'utf8'));
  forged.receipt.source = { kind: 'research', url: 42, retrievedAt: 'now', passageId: 'x', sourceTool: 'host_search' };
  await writeFile(file, JSON.stringify(forged));
  const rejected = new EvidenceStore({ storageDir });
  assert.equal((await rejected.expand({ id: receipt.id })).status, 'missing');
  const oversizedId = '00000000-0000-4000-8000-000000000000';
  await writeFile(join(storageDir, oversizedId + '.json'), Buffer.alloc(13 * 1024 * 1024, 65));
  const bounded = new EvidenceStore({ storageDir });
  assert.equal((await bounded.expand({ id: oversizedId })).status, 'missing');
  assert.equal((await lstat(join(storageDir, oversizedId + '.json')).catch(() => null)), null);
});

test('JSON and quoted known key assignments are redacted', async () => {
  const store = new EvidenceStore();
  const receipt = store.capture({ source: command, bytes: Buffer.from('{"TEAMOROUTER_API_KEY":"json-secret","OPENAI_API_KEY":"other-secret"}\n"FUSION_HTTP_BEARER_TOKEN" = "quoted-secret"\n') });
  assert.equal(receipt.redacted, true);
  const page = await store.expand({ id: receipt.id });
  assert.equal(page.status, 'ok');
  if (page.status === 'ok') {
    const text = Buffer.from(page.dataBase64, 'base64').toString();
    assert.doesNotMatch(text, /json-secret|other-secret|quoted-secret/);
    assert.match(text, /\[REDACTED\]/);
  }
});

test('known key before an incomplete UTF-8 tail is still redacted', async () => {
  const store = new EvidenceStore();
  const input = Buffer.concat([Buffer.from('{"TEAMOROUTER_API_KEY":"partial-secret"}\n'), Buffer.from([0xf0, 0x9f])]);
  const receipt = store.capture({ source: command, bytes: input, truncated: true, originalBytes: null });
  assert.equal(receipt.redacted, true);
  const page = await store.expand({ id: receipt.id });
  assert.equal(page.status, 'ok');
  if (page.status === 'ok') assert.doesNotMatch(Buffer.from(page.dataBase64, 'base64').toString(), /partial-secret/);
});

test('repairing a previously shared Windows cache discards all old receipts', async t => {
  if (process.platform !== 'win32') return;
  const parent = await mkdtemp(join(tmpdir(), 'fusion-untrusted-cache-'));
  const storageDir = join(parent, 'evidence');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const first = new EvidenceStore({ storageDir });
  const receipt = first.capture({ source: command, bytes: Buffer.from('forged payload') });
  const outside = join(parent, 'outside.txt');
  await writeFile(outside, 'must survive');
  const file = join(storageDir, receipt.id + '.json');
  const disk = JSON.parse(await readFile(file, 'utf8'));
  disk.receipt.source.argv = ['forged', 'provenance'];
  await writeFile(file, JSON.stringify(disk));
  await writeFile(join(storageDir, 'research-provenance.sqlite'), 'untrusted database bytes');
  const grant = spawnSync('icacls', [storageDir, '/grant', '*S-1-1-0:(OI)(CI)M'], { encoding: 'utf8' });
  assert.equal(grant.status, 0, grant.stderr);
  const reopened = new EvidenceStore({ storageDir });
  assert.equal((await reopened.expand({ id: receipt.id })).status, 'missing');
  assert.equal(await readFile(outside, 'utf8'), 'must survive');
  assert.deepEqual((await readdir(storageDir)).filter(name => name.endsWith('.json')), []);
});

test('a long-lived disk store keeps a bounded in-memory cache', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'fusion-memory-bound-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const server = new EvidenceStore({ storageDir, maxEntries: 2 });
  const other = new EvidenceStore({ storageDir, maxEntries: 2 });
  const ids = [];
  for (let index = 0; index < 6; index++) {
    ids.push(server.capture({ source: command, bytes: Buffer.from(`server ${index}`) }).id);
    other.capture({ source: command, bytes: Buffer.from(`other ${index}`) });
  }
  assert.ok((server as unknown as { entries: Map<string, unknown> }).entries.size <= 2);
  assert.equal((await server.expand({ id: ids[0]! })).status, 'missing');
});
