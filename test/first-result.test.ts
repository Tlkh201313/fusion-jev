import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateFixtureHome } from './private-fixture.js';

test('first noisy failure prints recovery command and recovers exact retained stdout',async t=>{
  const home=privateFixtureHome('fusion-first-result-');t.after(()=>rm(home,{recursive:true,force:true}));
  const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  const env={...process.env,LOCALAPPDATA:home,XDG_CACHE_HOME:home,FUSION_CONFIG_HOME:home,FUSION_ENV_FILE:'',TYPESAFE_API_KEY:'',JEV_API_KEY:'',TEAMOROUTER_API_KEY:''};
  const expected=Array.from({length:200},(_,i)=>`unchanged diagnostic context ${i}`).join('\n')+'\n';
  const code=`process.stdout.write(${JSON.stringify(expected)});process.stderr.write('src/example.ts:4:2 - error TS2322: fixture failure\\n');process.exitCode=2`;
  const args=['--import',import.meta.resolve('tsx'),cli];
  const run=spawnSync(process.execPath,[...args,'run','--',process.execPath,'-e',code],{env,encoding:'utf8'});
  assert.equal(run.status,2);assert.match(run.stderr,/fixture failure/);
  // The recovery line names the installed bin when one is on PATH, else this CLI's exact argv.
  const id=/^recoverStdout(?:=fusion-jev evidence |Argv=.*")([0-9a-f-]{36})(?: --raw$|",)/m.exec(run.stdout)?.[1];assert.ok(id,run.stdout);
  assert.ok(Buffer.byteLength(run.stdout)<Buffer.byteLength(expected));
  const recovered=spawnSync(process.execPath,[...args,'evidence',id,'--raw'],{env,encoding:'utf8'});
  assert.equal(recovered.status,0,recovered.stderr);assert.equal(recovered.stdout,expected);
});
