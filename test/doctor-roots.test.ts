import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { makeTempDir } from './helpers/tmp.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('keyless doctor rejects each root that would prevent local stdio startup', async (t) => {
  const home = await makeTempDir(t, 'fusion-doctor-roots-');
  const file = join(home, 'file.txt');
  await writeFile(file, 'fake');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  for (const roots of [
    { FUSION_WORKSPACE_ROOT: join(home, 'missing') },
    { FUSION_WORKSPACE_ROOT: file },
    { FUSION_WORKSPACE_ROOT: home, FUSION_WORKSPACE_ALLOWED_ROOTS: join(home, 'missing') },
  ]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'doctor', 'stdio'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TYPESAFE_API_KEY: '',
        JEV_API_KEY: '',
        TEAMOROUTER_API_KEY: '',
        FUSION_ENV_FILE: '',
        FUSION_CONFIG_HOME: home,
        ...roots,
      },
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /"status": "ready"/);
    assert.match(result.stderr, /root.*unavailable|root.*directory/i);
  }
});
