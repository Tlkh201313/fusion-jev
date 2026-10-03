import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StorageVerification, parseIcaclsSave, sddlIsPrivate } from '../src/acl.js';
import { EvidenceStore } from '../src/evidence.js';
import { privateFixtureHome } from './private-fixture.js';

const windows = process.platform === 'win32';
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const me = 'S-1-5-21-1-2-3-1001';

test('only the current user, SYSTEM and Administrators make an ACL private', () => {
  assert.equal(sddlIsPrivate(`D:PAI(A;OICI;FA;;;${me})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`, me), true);
  assert.equal(sddlIsPrivate(`D:AI(A;ID;FA;;;${me})(A;ID;FA;;;S-1-5-18)(A;ID;FA;;;S-1-5-32-544)`, me), true);
  assert.equal(
    sddlIsPrivate(`D:AI(A;ID;FA;;;${me})(D;;FA;;;WD)`, me),
    true,
    'deny entries are ignored, as in the PowerShell check',
  );
  assert.equal(sddlIsPrivate(`D:PAI(A;OICI;FR;;;WD)(A;OICI;FA;;;${me})`, me), false, 'Everyone');
  assert.equal(
    sddlIsPrivate(`D:PAI(A;OICI;FA;;;${me})(A;OICI;0x1301bf;;;S-1-5-21-9-9-9-1004)`, me),
    false,
    'another user',
  );
  assert.equal(sddlIsPrivate(`D:PAI(A;OICI;FA;;;AU)(A;OICI;FA;;;${me})`, me), false, 'authenticated users');
  assert.equal(
    sddlIsPrivate('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', me),
    false,
    'the current user must hold an entry',
  );
  assert.equal(sddlIsPrivate('D:PAI', me), false, 'an empty DACL grants the user nothing');
  assert.equal(sddlIsPrivate(`O:BAG:SY`, me), false, 'no DACL at all');
  assert.equal(sddlIsPrivate(`D:(XA;;FA;;;${me};(@User.x==1))`, me), false, 'unknown entry shapes are never trusted');
  assert.equal(sddlIsPrivate(`D:(OA;;FA;guid;;${me})`, me), false, 'object entries are never trusted');
  assert.equal(sddlIsPrivate(`D:(A;;FA;;;${me}`, me), false, 'malformed');
});

test('icacls /save output is paired by name and anything odd is rejected', () => {
  const encode = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const parsed = parseIcaclsSave(encode('a.json\r\nD:AI(A;ID;FA;;;SY)\r\nb.tmp\r\nD:AI(A;ID;FA;;;BA)\r\n\r\n'));
  assert.deepEqual(
    [...parsed!],
    [
      ['a.json', 'D:AI(A;ID;FA;;;SY)'],
      ['b.tmp', 'D:AI(A;ID;FA;;;BA)'],
    ],
  );
  assert.equal(parseIcaclsSave(encode('a.json\r\n')), undefined, 'a name without its descriptor');
  assert.equal(parseIcaclsSave(encode('a.json\r\nD:\r\na.json\r\nD:\r\n')), undefined, 'duplicate names');
});

/** A SystemRoot with the real icacls and whoami but a powershell.exe that rejects every invocation. */
function brokenPowerShellRoot(base: string): string {
  const root = join(base, 'fake-windows');
  const real = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  mkdirSync(join(root, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true });
  for (const name of ['icacls.exe', 'whoami.exe']) copyFileSync(join(real, name), join(root, 'System32', name));
  copyFileSync(process.execPath, join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  return root;
}

function withEnv<T>(values: Record<string, string>, work: () => T): T {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return work();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function grantEveryone(directory: string): void {
  const grant = spawnSync('icacls', [directory, '/grant', '*S-1-1-0:(OI)(CI)M'], { encoding: 'utf8' });
  assert.equal(grant.status, 0, grant.stderr);
}

// Windows environment names are case-insensitive, but a copied environment object is not: drop any other
// spelling of an overridden name so the child sees exactly the value given here.
function cliEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const overrides = {
    LOCALAPPDATA: home,
    XDG_CACHE_HOME: home,
    FUSION_CONFIG_HOME: home,
    FUSION_ENV_FILE: '',
    ...extra,
  };
  for (const key of Object.keys(env))
    if (Object.keys(overrides).some((name) => name.toLowerCase() === key.toLowerCase())) delete env[key];
  return { ...env, ...overrides };
}
const cacheDir = (home: string) => join(home, 'fusion-jev-mcp', 'evidence');
const big = "process.stdout.write('x'.repeat(3000)); process.exitCode = 7";
const runCli = (home: string, extra: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', tsxImport, cli, ...args], { encoding: 'utf8', env: cliEnv(home, extra) });

test('an already private cache is proven private without starting PowerShell', { skip: !windows }, async (t) => {
  const home = privateFixtureHome('fusion-acl-fast-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = brokenPowerShellRoot(home);
  const storageDir = join(home, 'evidence');
  // First open creates the directory (inheriting the private fixture ACL) and stores a receipt.
  const store = withEnv({ SystemRoot: fake }, () => new EvidenceStore({ storageDir }));
  const receipt = store.capture({
    source: { kind: 'command', cwd: home, argv: ['x'], channel: 'stdout' },
    bytes: Buffer.from('kept'),
  });
  // A second open must still succeed with a PowerShell that always fails: only the icacls check can have vouched for it.
  const reopened = withEnv({ SystemRoot: fake }, () => new EvidenceStore({ storageDir }));
  assert.equal((await reopened.expand({ id: receipt.id })).status, 'ok');
});

test(
  'a cache granted Everyone access is not trusted when PowerShell cannot repair it',
  { skip: !windows },
  async (t) => {
    const home = privateFixtureHome('fusion-acl-broken-');
    t.after(() => rm(home, { recursive: true, force: true }));
    const fake = brokenPowerShellRoot(home);
    const storageDir = join(home, 'evidence');
    mkdirSync(storageDir);
    writeFileSync(join(storageDir, '00000000-0000-4000-8000-000000000000.json'), '{"forged":true}');
    grantEveryone(storageDir);
    assert.throws(
      () => withEnv({ SystemRoot: fake }, () => new EvidenceStore({ storageDir })),
      /Unable to make evidence storage private/,
    );
    assert.equal(
      existsSync(join(storageDir, 'research-provenance.sqlite')),
      false,
      'nothing may be written to an unverified directory',
    );
  },
);

test(
  'a slow PowerShell is abandoned, retried once, then reported without writing anything',
  { skip: !windows },
  async (t) => {
    const home = privateFixtureHome('fusion-acl-slow-');
    t.after(() => rm(home, { recursive: true, force: true }));
    const storageDir = join(home, 'evidence');
    mkdirSync(storageDir);
    const planted = join(storageDir, '00000000-0000-4000-8000-000000000000.json');
    writeFileSync(planted, '{"old":true}');
    grantEveryone(storageDir);
    // The limit is read when PowerShell starts, after the quick icacls check, so keep it set until the verification ends.
    process.env.FUSION_ACL_TIMEOUT_MS = '1';
    try {
      await assert.rejects(
        new StorageVerification(storageDir).ready(),
        /Unable to make evidence storage private \(.*timed out/,
      );
    } finally {
      delete process.env.FUSION_ACL_TIMEOUT_MS;
    }
    // The timeouts landed before any repair was authorized, so the directory was left exactly as found.
    assert.equal(existsSync(planted), true);
    assert.match(spawnSync('icacls', [storageDir], { encoding: 'utf8' }).stdout, /Everyone|S-1-1-0/i);
  },
);

test('run keeps the command result when the cache cannot be verified', { skip: !windows }, async (t) => {
  const home = privateFixtureHome('fusion-acl-degrade-');
  t.after(() => rm(home, { recursive: true, force: true }));
  mkdirSync(cacheDir(home), { recursive: true });
  grantEveryone(cacheDir(home));
  const result = runCli(
    home,
    { FUSION_SYSTEM_ROOT: brokenPowerShellRoot(home) },
    'run',
    '--',
    process.execPath,
    '-e',
    big,
  );
  assert.equal(result.status, 7, result.stderr);
  assert.ok(result.stdout.startsWith('x'.repeat(3000)), 'the full (bounded) output is printed verbatim');
  const status = result.stdout.slice(3000).trim().split('\n');
  assert.equal(status.length, 1, 'one status line');
  assert.match(
    status[0]!,
    /^termination=exit exitCode=7 durationMs=\d+ noReceipt="Unable to make evidence storage private[^"]*; output above is verbatim"$/,
  );
  assert.deepEqual(readdirSync(cacheDir(home)), [], 'nothing is written to an unverified cache');
});

test('run reports a PowerShell timeout the same way and preserves the exit code', { skip: !windows }, async (t) => {
  const home = privateFixtureHome('fusion-acl-timeout-');
  t.after(() => rm(home, { recursive: true, force: true }));
  mkdirSync(cacheDir(home), { recursive: true });
  grantEveryone(cacheDir(home));
  const result = runCli(home, { FUSION_ACL_TIMEOUT_MS: '1' }, 'run', '--', process.execPath, '-e', big);
  assert.equal(result.status, 7, result.stderr);
  assert.match(
    result.stdout,
    /noReceipt="Unable to make evidence storage private \(.*timed out[^"]*; output above is verbatim"/,
  );
  assert.deepEqual(readdirSync(cacheDir(home)), []);
});

test('evidence recovery verifies a private cache without PowerShell', { skip: !windows }, async (t) => {
  const home = privateFixtureHome('fusion-acl-recover-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const created = runCli(home, {}, 'run', '--', process.execPath, '-e', big);
  assert.equal(created.status, 7, created.stderr);
  const id = /stdout=([0-9a-f-]{36})/.exec(created.stdout)?.[1];
  assert.ok(id, created.stdout);
  const recovered = runCli(home, { FUSION_SYSTEM_ROOT: brokenPowerShellRoot(home) }, 'evidence', id, '--raw');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, 'x'.repeat(3000));
});
