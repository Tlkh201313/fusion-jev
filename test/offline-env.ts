import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateFixtureHome } from './private-fixture.js';

// Fusion canonicalizes workspace paths, so fixtures must start from the canonical temp root:
// macOS's temp directory is a symlink (/var -> /private/var), and Windows runners expose an
// 8.3 short TEMP (RUNNER~1) that native realpath expands to the long name.
if (process.platform === 'win32') process.env.TEMP = process.env.TMP = realpathSync.native(tmpdir());
else process.env.TMPDIR = realpathSync(tmpdir());
for (const key of ['TYPESAFE_API_KEY','JEV_API_KEY','TEAMOROUTER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY']) delete process.env[key];
const config = privateFixtureHome('fusion-public-test-config-');
process.env.FUSION_CONFIG_HOME=config;
process.env.FUSION_ENV_FILE='';
process.on('exit',()=>rmSync(config,{recursive:true,force:true}));
