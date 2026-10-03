import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { makeTempDir } from './helpers/tmp.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistanceService } from '../src/assist.js';
import { EvidenceStore } from '../src/evidence.js';
import type { RoutingService } from '../src/mcp.js';
import { WorkspaceService } from '../src/workspace.js';

// A shell-string continuation loses argv boundaries and interprets script names as shell syntax.
test('discovered command continuation preserves hostile script names and cwd as structured host argv', async t => {
  const root = await makeTempDir(t, 'fusion-public-review-');
  const scope = 'folder with spaces & apostrophe\'s';
  const cwd = join(root, scope);
  await mkdir(cwd);
  const scriptName = 'test:quoted "path" & $(Write-Output stolen); %PATH% | echo nope';
  const sentinel = join(cwd, 'executed.txt');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: {
    [scriptName]: `node -e "require('node:fs').writeFileSync('executed.txt', 'bad')"`,
  } }));
  const router: RoutingService = {
    async route() { throw new Error('check discovery must not use Jev'); },
    async routeBatch() { throw new Error('check discovery must not use Jev'); },
  };
  const service = new AssistanceService(new WorkspaceService(root, router), router, new EvidenceStore());
  const result = await service.assist({ task: 'Run tests', scope });
  assert.equal(result.status, 'continue');
  assert.equal(result.stopReason, 'host_action');
  assert.equal(result.hostAction?.requiresApproval, true);
  assert.deepEqual(result.hostAction?.argv, ['npm', 'run', scriptName]);
  assert.equal(result.hostAction?.cwd, cwd);
  assert.deepEqual(result.hostAction?.execution, {
    program: 'fusion-jev', argv: ['run', `--cwd=${cwd}`, '--', 'npm', 'run', scriptName],
  });
  const instruction = result.hostAction!.instruction;
  const encoded = /Host argv JSON: (\[[^\n]+\])\n/.exec(instruction);
  assert.ok(encoded, 'command instructions must provide structured argv rather than copyable shell text');
  const hostArgv: unknown = JSON.parse(encoded[1]!);
  assert.deepEqual(hostArgv, ['run', `--cwd=${cwd}`, '--', 'npm', 'run', scriptName]);
  assert.match(instruction, /Native program: fusion-jev\n/);
  assert.match(instruction, /without joining .*shell/i);
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
});

test('public run CLI preserves hostile argv after separator and uses child exit status', async t => {
  const root = await makeTempDir(t, 'fusion-public-run-review-');
  const cwd = join(root, 'working directory with spaces & quote\'s');
  await mkdir(cwd);
  const args = ['a b', 'a"b', '--', '--env-file=literal', '--cwd=literal', '$(Write-Output stolen)', '%PATH%', 'x&y;z|w', '雪'];
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli,
    'run', '--raw', `--cwd=${cwd}`, '--', process.execPath, '-e',
    'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd()}));process.stderr.write("PASS all tests\\n");process.exitCode=7',
    ...args], { encoding: 'utf8', timeout: 15_000, shell: false,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() } });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 7, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { argv: args, cwd });
  assert.equal(run.stderr, 'PASS all tests\n');
});
