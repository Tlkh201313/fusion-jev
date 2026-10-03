import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run pack:smoke');
const root = await mkdtemp(join(tmpdir(), 'fusion-consumer-'));
const isolatedEnv = {
  ...process.env,
  FUSION_ENV_FILE: '',
  FUSION_CONFIG_HOME: join(root, 'config'),
  LOCALAPPDATA: join(root, 'cache'),
  XDG_CACHE_HOME: join(root, 'cache'),
  FUSION_FALLBACK: 'host',
  FUSION_WORKSPACE_ROOT: '',
  FUSION_WORKSPACE_ALLOWED_ROOTS: '',
  FUSION_HTTP_ENABLE_WORKSPACE: 'false',
};
isolatedEnv.npm_config_registry = 'https://registry.npmjs.org';
isolatedEnv.npm_config_userconfig = join(root, 'empty-user-npmrc');
isolatedEnv.npm_config_globalconfig = join(root, 'empty-global-npmrc');
isolatedEnv.npm_config_cache = join(root, 'npm-cache');
for (const key of ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'TEAMOROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
  isolatedEnv[key] = '';
function run(args, cwd = checkout) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: isolatedEnv,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Package smoke failed (${args[0]}): ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout;
}

try {
  const [packed] = JSON.parse(run([npmCli, 'pack', '--pack-destination', root, '--json', '--silent']));
  // The allocated empty consumer root is ours; protect it before writing any config/cache.
  const { EvidenceStore: LocalEvidenceStore } = await import('../dist/evidence.js');
  new LocalEvidenceStore({ storageDir: root });
  await mkdir(join(root, 'cache'));
  const paths = packed.files.map((file) => file.path);
  assert.ok(
    !paths.some((path) => /^(examples|src|test|scripts|benchmark|internal)\//.test(path) || path === 'server.json'),
  );
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/cli.js',
    'plugin/fusion-jev/plugin.json',
    'plugin/fusion-jev/.codex-plugin/plugin.json',
    'plugin/fusion-jev/.mcp.json',
    'plugin/fusion-jev/assets/logo.png',
    'plugin/fusion-jev/assets/icon.png',
    'plugin/fusion-jev-claude/.claude-plugin/plugin.json',
    'plugin/fusion-jev-claude/.mcp.json',
    'plugin/fusion-jev-claude/hooks/hooks.json',
    'plugin/fusion-jev-claude/skills/assist/SKILL.md',
  ])
    assert.ok(paths.includes(required), `Missing ${required}`);
  assert.equal(packed.filename, basename(packed.filename));
  const consumer = join(root, 'consumer');
  await mkdir(consumer);
  run([npmCli, 'install', '--prefix', consumer, '--omit=dev', '--no-audit', '--no-fund', join(root, packed.filename)]);
  const pluginRoot = join(consumer, 'node_modules', 'fusion-jev', 'plugin', 'fusion-jev');
  const manifest = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.skills, undefined, 'Routine MCP use must not load a bundled skill file');
  assert.match(manifest.interface.defaultPrompt.join(' '), /Fusion.*fusion_inspect/i);
  assert.match(manifest.interface.defaultPrompt.join(' '), /RTK/);
  assert.ok(!paths.some((path) => path.startsWith('plugin/fusion-jev/skills/')));
  for (const field of ['composerIcon', 'logo', 'logoDark']) {
    const icon = await readFile(join(pluginRoot, manifest.interface[field]));
    assert.equal(icon.subarray(1, 4).toString(), 'PNG');
    const width = icon.readUInt32BE(16),
      height = icon.readUInt32BE(20);
    assert.equal(width, height);
    assert.ok(width >= 48 && width <= 4096 && icon.length <= 5 * 1024 * 1024);
  }
  run(
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { FusionRouter, FusionExecutor, EvidenceStore, loadConfig, createFusionMcpServer } from 'fusion-jev';
    assert.equal(typeof FusionExecutor, 'function');
    assert.equal(typeof createFusionMcpServer, 'function');
    const router = new FusionRouter({config: loadConfig({})});
    const result = await router.route({task:'Lookup', tools:[{name:'lookup', description:'Lookup', inputSchema:{type:'object', properties:{}, additionalProperties:false}}]});
    assert.equal(result.decision.status, 'escalate');
    const storageDir = mkdtempSync(join(process.env.LOCALAPPDATA, 'fusion-consumer-disk-'));
    try {
      const first = new EvidenceStore({storageDir, maxEntries:1});
      const second = new EvidenceStore({storageDir, maxEntries:1});
      const source = {kind:'command', cwd:process.cwd(), argv:['node'], channel:'stdout'};
      const old = first.capture({source, bytes:Buffer.from('old')});
      const current = second.capture({source, bytes:Buffer.from('new')});
      assert.equal((await first.expand({id:old.id})).status, 'missing');
      assert.equal((await first.expand({id:current.id})).status, 'ok');
    } finally { rmSync(storageDir, {recursive:true, force:true}); }
  `,
    ],
    consumer,
  );
  run(
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {resolve, delimiter} from 'node:path';
    import {Client} from '@modelcontextprotocol/sdk/client/index.js';
    import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
    const plugin = resolve('node_modules/fusion-jev/plugin/fusion-jev-claude');
    const config = JSON.parse(readFileSync(resolve(plugin, '.mcp.json'), 'utf8')).mcpServers.fusion;
    assert.equal(config.env_vars, undefined);
    const client = new Client({name:'claude-plugin-consumer',version:'1'});
    try {
      assert.equal(config.env.FUSION_WORKSPACE_ROOT,'\${CLAUDE_PROJECT_DIR}');
      assert.equal(config.command,'npx');
      assert.deepEqual(config.args,['-y','fusion-jev@${version}','stdio'],'plugin pins the packed version');
      // Launch exactly what the manifest says (command and args, unmodified). The SDK transport spawns through
      // cross-spawn, so npx resolves to npx.cmd on Windows. The registry points at a dead address and npm is offline,
      // so this only passes if npx resolves the pinned fusion-jev@<version> from the consumer's installed tarball
      // without the network. It cannot prove that the registry serves that version after publish; only a published
      // package can show that.
      await client.connect(new StdioClientTransport({command:config.command,args:config.args,cwd:process.cwd(),
        env:{...process.env,...config.env,FUSION_WORKSPACE_ROOT:process.cwd(),TYPESAFE_API_KEY:'',JEV_API_KEY:'',
          npm_config_offline:'true',npm_config_registry:'http://127.0.0.1:9/',npm_config_fetch_retries:'0'}}));
      assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['fusion_assist','fusion_inspect','fusion_evidence']);
      const result=await client.callTool({name:'fusion_inspect',arguments:{requests:[{action:'read',path:'package.json',maxLines:2}]}});
      assert.equal(result.isError,undefined);
      const id=result.structuredContent.evidenceRefs[0].receipt.id;
      const text=await client.callTool({name:'fusion_evidence',arguments:{action:'get',id,format:'utf8'}});
      assert.equal(text.structuredContent.encoding,'utf8');
    } finally {await client.close();}
  `,
    ],
    consumer,
  );
  assert.match(run([join(consumer, 'node_modules/fusion-jev/dist/cli.js'), '--help'], consumer), /stdio/);
  const consumerCli = join(consumer, 'node_modules/fusion-jev/dist/cli.js');
  assert.equal(JSON.parse(run([consumerCli, 'doctor', 'stdio'], consumer)).providers.jev, 'missing');
  assert.match(run([consumerCli, 'setup', '--dry-run'], consumer), /no files written/);
  assert.match(run([consumerCli, 'setup'], consumer), /private provider template/);
  run(
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {resolve, delimiter} from 'node:path';
    import {Client} from '@modelcontextprotocol/sdk/client/index.js';
    import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
    for (const [profile, expected] of [
      ['assist', ['fusion_assist', 'fusion_inspect', 'fusion_evidence']],
      ['full', ['fusion_repo_overview', 'fusion_inspect', 'fusion_list_files', 'fusion_read_file', 'fusion_search_text',
        'fusion_git_status', 'fusion_git_diff', 'fusion_git_log', 'fusion_workspace', 'fusion_choose', 'fusion_choose_batch',
        'fusion_route', 'fusion_route_batch', 'fusion_assist', 'fusion_evidence']],
    ]) {
      const client = new Client({name:'package-smoke', version:'1'});
      const transport = new StdioClientTransport({command:'fusion-jev', args:['stdio'], env:{...process.env,PATH:resolve('node_modules/.bin') + delimiter + process.env.PATH, TYPESAFE_API_KEY:'', JEV_API_KEY:'', OPENAI_API_KEY:'', FUSION_MCP_PROFILE:profile}});
      try { await client.connect(transport); assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), expected); }
      finally { await client.close(); }
    }
  `,
    ],
    consumer,
  );
  process.stdout.write(
    'Clean consumer: package contents, native disk evidence, public exports, CLI and stdio MCP passed.\n',
  );
} finally {
  // Remove only the directory allocated by this invocation, inside the OS temp root.
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('fusion-consumer-'));
  await rm(root, { recursive: true, force: true });
}
