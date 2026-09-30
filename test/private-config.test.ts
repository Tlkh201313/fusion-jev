import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assertPrivatePath, preparePrivateDirectory } from '../src/private-config.js';
import { privateFixtureHome } from './private-fixture.js';

test('private provider file is rejected when other users can replace it through its parent',async t=>{
  const root=privateFixtureHome('fusion-parent-boundary-');t.after(()=>rm(root,{recursive:true,force:true}));
  const parent=preparePrivateDirectory(join(root,'private'));
  const file=join(parent,'provider.env');await writeFile(file,'TYPESAFE_API_KEY=fake\n',{mode:0o600});
  assert.equal(assertPrivatePath(file,false),file);
  if(process.platform==='win32') {
    const grant=spawnSync('icacls',[parent,'/grant','*S-1-1-0:(WD,DC)'],{encoding:'utf8'});assert.equal(grant.status,0,grant.stderr);
  } else await chmod(parent,0o777);
  assert.throws(()=>assertPrivatePath(file,false),/private|parent/i);
});
