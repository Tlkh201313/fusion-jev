import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateFixtureHome } from './private-fixture.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function run(home: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, 'setup', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FUSION_CONFIG_HOME: home,
      FUSION_ENV_FILE: '',
      TYPESAFE_API_KEY: '',
      JEV_API_KEY: '',
      TEAMOROUTER_API_KEY: '',
    },
  });
}

test('setup dry run emits absolute host instructions without creating files', async (t) => {
  const home = privateFixtureHome('fusion setup spaces ');
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = run(home, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex mcp add/);
  assert.match(result.stdout, /claude mcp add/);
  assert.match(result.stdout, /provider\.env/);
  assert.match(result.stdout, /--provider-env=/);
  await assert.rejects(stat(join(home, 'fusion-jev-mcp')));
});

test('setup creates private blank template and preserves it on rerun', async (t) => {
  const home = privateFixtureHome('fusion-setup-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = run(home, []);
  assert.equal(first.status, 0, first.stderr);
  const dir = join(home, 'fusion-jev-mcp'),
    file = join(dir, 'provider.env');
  const text = await readFile(file, 'utf8');
  assert.match(text, /TYPESAFE_API_KEY=\s*\n/);
  assert.match(text, /FUSION_FALLBACK=host/);
  assert.equal(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).envFile, file);
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  await writeFile(file, 'TYPESAFE_API_KEY=sentinel-private-value\n');
  const rerun = run(home, []);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(await readFile(file, 'utf8'), 'TYPESAFE_API_KEY=sentinel-private-value\n');
  assert.doesNotMatch(first.stdout + rerun.stdout, /sentinel-private-value/);
});

test('setup refuses relative or unavailable trusted env files', async (t) => {
  const home = privateFixtureHome('fusion-setup-input-');
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const path of ['.env', join(home, 'missing.env')]) {
    const result = run(home, [`--provider-env=${path}`]);
    assert.equal(result.status, 1);
  }
});

test('setup refuses an existing provider file shared with other users', async (t) => {
  const home = privateFixtureHome('fusion-shared-provider-');
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(run(home, []).status, 0);
  const file = join(home, 'fusion-jev-mcp', 'provider.env');
  if (process.platform === 'win32') {
    const grant = spawnSync('icacls', [file, '/grant', '*S-1-1-0:R'], { encoding: 'utf8' });
    assert.equal(grant.status, 0, grant.stderr);
  } else await chmod(file, 0o644);
  const result = run(home, []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private/i);
});

const pkgVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string;
async function dryRun(executable: string, cliPath: string) {
  const { prepareSetup } = await import('../src/setup.js');
  return prepareSetup({ configDir: join(tmpdir(), 'fusion-setup-unit'), executable, cliPath, dryRun: true })
    .instructions;
}
function assertPinnedNpx(text: string) {
  const npx = `npx -y fusion-jev@${pkgVersion}`;
  assert.ok(text.includes(`\n${npx} doctor stdio '--provider-env=`), text);
  assert.ok(text.includes(`codex mcp add fusion-jev -- ${npx} stdio '--provider-env=`), text);
  assert.ok(
    text.includes(`claude mcp add --transport stdio --scope user fusion-jev -- ${npx} stdio '--provider-env=`),
    text,
  );
  assert.match(text, /npm i -g fusion-jev/);
  assert.doesNotMatch(text, /_npx|cli\.js/);
  if (process.platform === 'win32') assert.ok(text.includes(`fusion-jev -- cmd /c ${npx} stdio`), text);
  else assert.doesNotMatch(text, /cmd \/c/);
}

test(
  'setup names the pinned npx package when running from a Windows-style npx cache',
  { skip: process.platform !== 'win32' && 'Windows paths are not absolute here' },
  async () => {
    assertPinnedNpx(
      await dryRun(
        String.raw`C:\Program Files\nodejs\node.exe`,
        String.raw`C:\Users\u\AppData\Local\npm-cache\_npx\838123eac27a83ce\node_modules\fusion-jev\dist\cli.js`,
      ),
    );
  },
);

test('setup names the pinned npx package when running from a POSIX-style npx cache', async () => {
  assertPinnedNpx(
    await dryRun('/usr/bin/node', '/home/u/.npm/_npx/838123eac27a83ce/node_modules/fusion-jev/dist/cli.js'),
  );
});

test('setup keeps absolute-path commands outside the npx cache', async () => {
  const node = process.platform === 'win32' ? String.raw`C:\Program Files\nodejs\node.exe` : '/usr/bin/node';
  const cliPath =
    process.platform === 'win32'
      ? String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\fusion-jev\dist\cli.js`
      : '/usr/lib/node_modules/fusion-jev/dist/cli.js';
  const text = await dryRun(node, cliPath);
  const prefix = process.platform === 'win32' ? '& ' : '';
  const env = `'--provider-env=${join(tmpdir(), 'fusion-setup-unit', 'provider.env')}'`;
  assert.ok(text.includes(`\n${prefix}'${node}' '${cliPath}' doctor stdio ${env}\n`), text);
  assert.ok(
    text.includes(
      `\ncodex mcp add fusion-jev -- '${node}' '${cliPath}' stdio ${env}\nclaude mcp add --transport stdio --scope user fusion-jev -- '${node}' '${cliPath}' stdio ${env}\nHost configurations were not changed.`,
    ),
    text,
  );
  assert.doesNotMatch(text, /npx|npm i -g/);
});
