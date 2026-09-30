import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveUserConfigPath } from '../src/config-path.js';

test('Windows default dry-run selects the isolated private home namespace',()=>{
  if(process.platform!=='win32')return;
  const env={...process.env};delete env.FUSION_CONFIG_HOME;
  const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'setup','--dry-run'],{encoding:'utf8',env});
  assert.equal(result.status,0,result.stderr);
  assert.ok(result.stdout.includes(join(homedir(),'.fusion-jev-mcp','provider.env')));
});

test('config path resolution uses the same explicit namespace across platforms without filesystem writes',()=>{
  const fakeHome=join(process.cwd(),'fake-home');
  assert.equal(resolveUserConfigPath({},'win32',fakeHome),join(fakeHome,'.fusion-jev-mcp','config.json'));
  assert.equal(resolveUserConfigPath({APPDATA:join(fakeHome,'unsafe-appdata')},'win32',fakeHome),join(fakeHome,'.fusion-jev-mcp','config.json'));
  const explicit=join(fakeHome,'explicit');
  for(const platform of ['win32','linux','darwin'] as const)
    assert.equal(resolveUserConfigPath({FUSION_CONFIG_HOME:explicit},platform,fakeHome),join(explicit,'fusion-jev-mcp','config.json'));
  assert.throws(()=>resolveUserConfigPath({FUSION_CONFIG_HOME:'relative'},'win32',fakeHome),/absolute/);
});
