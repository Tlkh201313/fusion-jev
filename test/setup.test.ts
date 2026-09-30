import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateFixtureHome } from './private-fixture.js';

const cli = fileURLToPath(new URL('../src/cli.ts',import.meta.url));
function run(home:string,args:string[]) {
  return spawnSync(process.execPath,['--import','tsx',cli,'setup',...args],{encoding:'utf8',env:{...process.env,
    FUSION_CONFIG_HOME:home,FUSION_ENV_FILE:'',TYPESAFE_API_KEY:'',JEV_API_KEY:'',TEAMOROUTER_API_KEY:''}});
}

test('setup dry run emits absolute host instructions without creating files',async t=>{
  const home=privateFixtureHome('fusion setup spaces ');t.after(()=>rm(home,{recursive:true,force:true}));
  const result=run(home,['--dry-run']);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/codex mcp add/);assert.match(result.stdout,/claude mcp add/);
  assert.match(result.stdout,/provider\.env/);assert.match(result.stdout,/--provider-env=/);
  await assert.rejects(stat(join(home,'fusion-jev-mcp')));
});

test('setup creates private blank template and preserves it on rerun',async t=>{
  const home=privateFixtureHome('fusion-setup-');t.after(()=>rm(home,{recursive:true,force:true}));
  const first=run(home,[]);assert.equal(first.status,0,first.stderr);
  const dir=join(home,'fusion-jev-mcp'),file=join(dir,'provider.env');
  const text=await readFile(file,'utf8');assert.match(text,/TYPESAFE_API_KEY=\s*\n/);assert.match(text,/FUSION_FALLBACK=host/);
  assert.equal(JSON.parse(await readFile(join(dir,'config.json'),'utf8')).envFile,file);
  if(process.platform!=='win32'){assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(file)).mode&0o777,0o600);}
  await writeFile(file,'TYPESAFE_API_KEY=sentinel-private-value\n');
  const rerun=run(home,[]);assert.equal(rerun.status,0,rerun.stderr);
  assert.equal(await readFile(file,'utf8'),'TYPESAFE_API_KEY=sentinel-private-value\n');
  assert.doesNotMatch(first.stdout+rerun.stdout,/sentinel-private-value/);
});

test('setup refuses relative or unavailable trusted env files',async t=>{
  const home=privateFixtureHome('fusion-setup-input-');t.after(()=>rm(home,{recursive:true,force:true}));
  for(const path of ['.env',join(home,'missing.env')]){const result=run(home,[`--provider-env=${path}`]);assert.equal(result.status,1);}
});

test('setup refuses an existing provider file shared with other users',async t=>{
  const home=privateFixtureHome('fusion-shared-provider-');t.after(()=>rm(home,{recursive:true,force:true}));
  assert.equal(run(home,[]).status,0);
  const file=join(home,'fusion-jev-mcp','provider.env');
  if(process.platform==='win32') {
    const grant=spawnSync('icacls',[file,'/grant','*S-1-1-0:R'],{encoding:'utf8'});assert.equal(grant.status,0,grant.stderr);
  } else await chmod(file,0o644);
  const result=run(home,[]);assert.equal(result.status,1);assert.match(result.stderr,/private/i);
});
