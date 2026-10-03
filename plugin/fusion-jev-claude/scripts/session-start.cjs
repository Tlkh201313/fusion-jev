// Context only: no tools, model calls, shell rewrites or permission decisions.
// Kept short (<= 500 chars); tool details live in the MCP server instructions.
const { version } = require('../.claude-plugin/plugin.json');
if (/^(off|0|false|no)$/i.test(process.env.FUSION_HOOKS || '')) process.exit(0);
const context = `Use Fusion via fusion_assist first for routine reads/searches/Git/commands, even small known tasks. Jev selects actions. command:{program,argv} plans commands. fusion_inspect only on failure/recovery; fusion_evidence for receipts. Run fusion-jev run -- program argv... if installed globally, else npx -y fusion-jev@${version} run -- program argv... (PowerShell: '--'; --raw for short output). Absolute project root; no extra Jev approval. Native tools on failure/unsupported work. Claude verifies.`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }) + '\n');
