// Opt-in auto-wrap (fusion-jev config auto-wrap on, or FUSION_AUTO_WRAP=1).
// Rewrites only simple, known-noisy commands so their output reaches Claude compactly
// with recoverable receipts. Never sets a permission decision; anything unrecognized
// passes through untouched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plain words only: no quotes, variables, globs, redirects, pipes, chaining or subshells.
const SIMPLE = /^[A-Za-z0-9_@%+=:,./-]+(?: +[A-Za-z0-9_@%+=:,./-]+)*$/;
const NOISY = [
  /^npm (?:test|t|run (?:test|build|lint|typecheck|check)(?::[\w-]+)?)(?: |$)/,
  /^(?:pnpm|yarn) (?:test|build|lint|typecheck|run (?:test|build|lint|typecheck|check)(?::[\w-]+)?)(?: |$)/,
  /^npx (?:tsc|jest|vitest run|eslint|mocha)(?: |$)/,
  /^(?:pytest|python3? -m pytest|tsc|jest|vitest run|eslint|ruff check|mypy)(?: |$)/,
  /^cargo (?:build|test|check|clippy)(?: |$)/,
  /^go (?:test|build|vet)(?: |$)/,
  /^(?:make|mvn|gradle|\.\/gradlew|dotnet (?:build|test))(?: |$)/,
];

function enabled(env) {
  if (env.FUSION_AUTO_WRAP === '1') return true;
  if (env.FUSION_AUTO_WRAP === '0') return false;
  const base = env.FUSION_CONFIG_HOME ? path.join(env.FUSION_CONFIG_HOME, 'fusion-jev-mcp')
    : process.platform === 'win32' ? path.join(os.homedir(), '.fusion-jev-mcp')
      : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fusion-jev-mcp');
  try { return JSON.parse(fs.readFileSync(path.join(base, 'auto-wrap.json'), 'utf8')).enabled === true; }
  catch { return false; }
}

function onPath(name, env) {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  return (env.PATH || '').split(path.delimiter).some(directory => directory && path.isAbsolute(directory)
    && extensions.some(extension => { try { return fs.statSync(path.join(directory, name + extension)).isFile(); } catch { return false; } }));
}

function launcher(env) {
  if (onPath('fusion-jev', env)) return 'fusion-jev';
  // Same pinned package the plugin's MCP server already fetched into the npx cache.
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    if (/^\d+\.\d+\.\d+$/.test(version)) return `npx -y --package=fusion-jev-mcp@${version} fusion-jev`;
  } catch { /* Fall through: without a launcher nothing is rewritten. */ }
  return undefined;
}

function decide(input, env) {
  if (!input || input.tool_name !== 'Bash' || !input.tool_input || typeof input.tool_input.command !== 'string') return undefined;
  const command = input.tool_input.command.trim();
  if (!SIMPLE.test(command) || !NOISY.some(pattern => pattern.test(command)) || !enabled(env)) return undefined;
  const run = launcher(env);
  if (!run) return undefined;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: `${run} run -- ${command}` } } };
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let decision;
    try { decision = decide(JSON.parse(raw), process.env); } catch { decision = undefined; }
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
  });
}

module.exports = { decide };
