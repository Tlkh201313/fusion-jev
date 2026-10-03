import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateFixtureHome } from './private-fixture.js';
import { envWithPathFirst, pathKey } from './helpers/env.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const cliArgs = (...args: string[]) => ['--import', tsxImport, cli, ...args];

// The CLI prints the short recovery form only when `fusion-jev` is on PATH. Put a stand-in launcher first on PATH
// so the compact output never depends on a globally installed package, and assert that it is the one that resolves.
function resolveOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (env[pathKey(env)] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) { const candidate = join(dir, name + ext); if (existsSync(candidate)) return candidate; }
  }
  return undefined;
}

function fixtureEnv(home: string): NodeJS.ProcessEnv {
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, process.platform === 'win32' ? 'fusion-jev.cmd' : 'fusion-jev');
  writeFileSync(launcher, '');
  const env = { ...envWithPathFirst(process.env, bin), LOCALAPPDATA: home, XDG_CACHE_HOME: home, FUSION_CONFIG_HOME: home,
    FUSION_ENV_FILE: '', TYPESAFE_API_KEY: '', JEV_API_KEY: '', TEAMOROUTER_API_KEY: '' };
  assert.equal(resolveOnPath('fusion-jev', env), launcher, 'fake fusion-jev launcher must shadow any globally installed one');
  return env;
}

function run(home: string, ...args: string[]) {
  return spawnSync(process.execPath, cliArgs('run', ...args), { encoding: 'utf8', env: fixtureEnv(home) });
}

const storeDir = (home: string) => join(home, 'fusion-jev-mcp');
const fixture = "for (let i=0;i<200;i++) console.log('unchanged context '+i); console.error('src/example.ts:4:2 - error TS2322: fixture failure'); process.exitCode=2";

test('small complete output prints verbatim with one status line and no receipt noise', async t => {
  const home = privateFixtureHome('fusion-run-compact-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = run(home, '--', process.execPath, '-e', 'process.stdout.write("hello\\n");process.stderr.write("warn\\n");process.exitCode=3');
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /^hello\nexitCode=3 durationMs=\d+\n$/);
  assert.equal(result.stderr, 'warn\n');
  // Fully shown output needs no recovery, so the persistent store is never opened.
  assert.equal(existsSync(storeDir(home)), false, 'small output must not initialize the evidence store');
});

test('small output without trailing newline and empty output keep a separate status line', async t => {
  const home = privateFixtureHome('fusion-run-compact-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const version = run(home, '--', process.execPath, '-e', 'process.stdout.write("v1")');
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^v1\nexitCode=0 durationMs=\d+\n$/);
  assert.equal(version.stderr, '');
  const empty = run(home, '--', process.execPath, '-e', '');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /^exitCode=0 durationMs=\d+\n$/);
  assert.equal(empty.stderr, '');
});

test('large output keeps compact diagnostics with only non-default flags and one recovery line', async t => {
  const home = privateFixtureHome('fusion-run-compact-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = run(home, '--', process.execPath, '-e', fixture);
  assert.equal(result.status, 2, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^termination=exit exitCode=2 durationMs=\d+ stdout=[0-9a-f-]{36} stdoutStoredBytes=\d+ stderr=[0-9a-f-]{36} stderrStoredBytes=\d+$/);
  assert.doesNotMatch(result.stdout, /=false|OriginalBytes|unparsedBytes=0|diagnosticsOmitted=0|excerptsClipped=0/);
  assert.match(result.stdout, /^omittedBytes=\d+$/m);
  // The small stderr channel is shown verbatim (exact diagnostic text), so it needs no recovery line.
  assert.equal(result.stderr, 'src/example.ts:4:2 - error TS2322: fixture failure\n');
  const recover = lines.filter(line => /^recover/.test(line));
  assert.equal(recover.length, 1, 'only the omitted stdout channel needs a recovery line');
  const id = /^stdout=([0-9a-f-]{36})$/m.exec(lines[0]!.replaceAll(' ', '\n'))?.[1];
  assert.ok(id);
  assert.ok(recover[0]!.includes(id));
  assert.match(recover[0]!, /^recoverStdout=(?:fusion-jev|npx -y fusion-jev@\S+) evidence [0-9a-f-]{36} --raw$|^recoverStdoutArgv=\[/);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) < 500, `compact output too large: ${result.stdout}${result.stderr}`);
  const recovered = spawnSync(process.execPath, cliArgs('evidence', id, '--raw'), { encoding: 'utf8', env: fixtureEnv(home) });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, Array.from({ length: 200 }, (_, i) => `unchanged context ${i}\n`).join(''));
});

test('truncated or redacted small output never uses the verbatim form', async t => {
  const home = privateFixtureHome('fusion-run-compact-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const capped = run(home, '--max-capture-bytes=1', '--', process.execPath, '-e', 'process.stdout.write("1234");process.stderr.write("warn")');
  assert.equal(capped.status, 0, capped.stderr);
  assert.match(capped.stdout, /^termination=exit exitCode=0 durationMs=\d+ stdout=[0-9a-f-]{36} stdoutStoredBytes=1 stdoutOriginalBytes=4 stdoutTruncated=true stderr=[0-9a-f-]{36} stderrStoredBytes=1 stderrOriginalBytes=4 stderrTruncated=true\n/);
  const redacted = run(home, '--', process.execPath, '-e', 'process.stdout.write("TYPESAFE_API_KEY=topsecret\\n")');
  assert.equal(redacted.status, 0, redacted.stderr);
  assert.match(redacted.stdout, /^termination=exit exitCode=0 durationMs=\d+ stdout=[0-9a-f-]{36} stdoutStoredBytes=\d+ stdoutOriginalBytes=\d+ stdoutRedacted=true\n/);
  assert.doesNotMatch(redacted.stdout, /topsecret|stderr=/);
});

test('binary small output and launch failures keep the compact form and exit codes', async t => {
  const home = privateFixtureHome('fusion-run-compact-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const binary = spawnSync(process.execPath, cliArgs('run', '--', process.execPath, '-e', 'process.stdout.write(Buffer.from([0xff,0xfe,10]));process.exitCode=4'),
    { env: fixtureEnv(home) });
  assert.equal(binary.status, 4, binary.stderr.toString());
  assert.match(binary.stdout.toString('latin1'), /^termination=exit exitCode=4 durationMs=\d+ stdout=[0-9a-f-]{36} stdoutStoredBytes=3\n/);
  assert.equal(binary.stdout.includes(Buffer.from([0xff, 0xfe])), false);
  const missing = run(home, '--', 'fusion-no-such-executable-929490');
  assert.equal(missing.status, 127, missing.stderr);
  // Windows shells may describe the missing program on stderr; an empty stdout channel gets no receipt.
  assert.match(missing.stdout, /^termination=spawn_error exitCode=null errorCode=not_found durationMs=\d+(?: stderr=[0-9a-f-]{36} stderrStoredBytes=\d+)?\n$/);
});
