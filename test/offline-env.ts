import { realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { privateFixtureHome } from './private-fixture.js';

// Fixtures compare paths the product reports after canonicalization, so give every test process
// (and its children) a physical temp directory: macOS /var is a symlink to /private/var and
// Windows runners expose TEMP as an 8.3 short path (RUNNER~1).
const physicalTemp = realpathSync.native(tmpdir());
process.env.TMPDIR = physicalTemp;
if (process.platform === 'win32') {
  process.env.TEMP = physicalTemp;
  process.env.TMP = physicalTemp;
}

for (const key of ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'TEAMOROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
  delete process.env[key];
const config = privateFixtureHome('fusion-public-test-config-');
process.env.FUSION_CONFIG_HOME = config;
process.env.FUSION_ENV_FILE = '';
process.on('exit', () => rmSync(config, { recursive: true, force: true }));
