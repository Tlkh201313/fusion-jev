import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateFixtureHome } from './private-fixture.js';

for (const key of ['TYPESAFE_API_KEY','JEV_API_KEY','TEAMOROUTER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY']) delete process.env[key];
const config = privateFixtureHome('fusion-public-test-config-');
process.env.FUSION_CONFIG_HOME=config;
process.env.FUSION_ENV_FILE='';
process.on('exit',()=>rmSync(config,{recursive:true,force:true}));
