import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { privateFixtureHome } from './private-fixture.js';

test('Windows ACL verification ignores a powershell.exe in the working directory', async (t) => {
  if (process.platform !== 'win32') return;
  const root = privateFixtureHome('fusion-helper-lookup-');
  t.after(() => rm(root, { recursive: true, force: true }));
  // A harmless Node executable rejects PowerShell flags if Windows resolves cwd first.
  await copyFile(process.execPath, join(root, 'powershell.exe'));
  const privateModule = pathToFileURL(join(process.cwd(), 'src/private-config.ts')).href;
  const evidenceModule = pathToFileURL(join(process.cwd(), 'src/evidence.ts')).href;
  const code = `import {preparePrivateDirectory} from ${JSON.stringify(privateModule)}; import {EvidenceStore} from ${JSON.stringify(evidenceModule)}; import {join} from 'node:path'; preparePrivateDirectory(join(process.cwd(),'config')); new EvidenceStore({storageDir:join(process.cwd(),'evidence')}); console.log('trusted-system-helper');`;
  const result = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code],
    { cwd: root, encoding: 'utf8', env: { ...process.env } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trusted-system-helper/);
});
