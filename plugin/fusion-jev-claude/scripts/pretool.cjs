// PreToolUse advisor. Fails open: any error, timeout or unknown input exits 0 with no output.
// Only decision ever emitted: deny, once per file per session, for a whole-file Read of a large file.
// Everything else is additionalContext. It never emits allow/ask and never changes permissions.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (/^(off|0|false|no)$/i.test(process.env.FUSION_HOOKS || '')) process.exit(0);
setTimeout(() => process.exit(0), 1500).unref();

const MAX_STATE = 100;
const ADVICE_LIMIT = 3;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.pdf', '.ipynb', '.zip', '.gz', '.tgz', '.exe', '.dll', '.so', '.bin', '.mp4', '.mov', '.mp3', '.wav', '.woff', '.woff2', '.ttf']);

const posInt = (value, fallback) => { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
const emit = payload => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...payload } }) + '\n'); };
const advise = additionalContext => emit({ additionalContext });
const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);

function statePath(sessionId) {
  const id = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return id ? path.join(os.tmpdir(), `fusion-jev-hooks-${id}.json`) : null;
}
function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { denied: Array.isArray(s.denied) ? s.denied.slice(-MAX_STATE) : [], advised: s.advised && typeof s.advised === 'object' ? s.advised : {} };
  } catch { return { denied: [], advised: {} }; }
}
function saveState(file, state) {
  try { fs.writeFileSync(file, JSON.stringify({ denied: state.denied.slice(-MAX_STATE), advised: state.advised })); } catch { /* best effort */ }
}
const pluginVersion = () => { try { return require('../.claude-plugin/plugin.json').version; } catch { return 'latest'; } };

function transcriptShowsOutline(transcript, file) {
  if (!transcript) return false;
  try {
    const fd = fs.openSync(transcript, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const base = path.basename(file).toLowerCase();
      return buf.toString('utf8').split('\n').some(line => {
        const l = line.toLowerCase();
        return l.includes('fusion_inspect') && l.includes('outline') && l.includes(base);
      });
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

function handleRead(input, event, state, file) {
  if (input.offset != null || input.limit != null || input.pages != null) return;
  const raw = input.file_path || input.path;
  if (typeof raw !== 'string' || !raw || !file) return;
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  const resolved = path.resolve(cwd, raw);
  const rel = path.relative(norm(path.resolve(cwd)), norm(resolved));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  if (SKIP_EXT.has(path.extname(resolved).toLowerCase())) return;
  const maxBytes = posInt(process.env.FUSION_READ_BYTES, 20000);
  const maxLines = posInt(process.env.FUSION_READ_LINES, 400);
  let st;
  try { st = fs.statSync(resolved); } catch { return; }
  if (!st.isFile()) return;
  let large = st.size > maxBytes;
  let lines = 0;
  if (!large) {
    const buf = fs.readFileSync(resolved);
    if (buf.includes(0)) return;
    for (const byte of buf) if (byte === 10) lines += 1;
    large = lines + 1 > maxLines;
  }
  if (!large) return;
  const key = norm(resolved);
  if (state.denied.includes(key)) return;
  if (transcriptShowsOutline(event.transcript_path, resolved)) return;
  state.denied.push(key);
  saveState(file, state);
  const size = lines ? `${lines + 1} lines` : `${Math.round(st.size / 1024)} KB`;
  emit({
    permissionDecision: 'deny',
    permissionDecisionReason: `Whole-file Read of a large file (${size}). Use fusion_inspect op outline {path}, then op symbol {path, name} or op read with a line range; or Read with offset/limit. Repeating this exact Read is allowed.`,
  });
}

function bump(state, file, kind) {
  const n = state.advised[kind] || 0;
  if (n >= ADVICE_LIMIT) return false;
  state.advised[kind] = n + 1;
  if (file) saveState(file, state);
  return true;
}

function handleGrep(input, state, file) {
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const unbounded = input.output_mode === 'content' && input.head_limit == null;
  const broad = pattern.length <= 2 || /^\.[*+]?$/.test(pattern);
  if (!unbounded && !broad) return;
  if (!bump(state, file, 'grep')) return;
  advise('Fusion: fusion_inspect op grep {pattern, path?, glob?, mode: content|files|count, topK} returns bounded results; consider it, or set head_limit.');
}

const NOISY = [
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b/,
  /^(npx\s+)?tsc\b/,
  /^(python3?\s+-m\s+)?pytest\b/,
  /^cargo\s+(test|build|clippy)\b/,
  /^go\s+(test|build|vet)\b/,
  /^git\s+log\b.*(\s-p\b|--patch\b)/,
];
function isNoisyDiff(cmd) {
  if (!/^git\s+diff\b/.test(cmd)) return false;
  if (/--(stat|shortstat|numstat|name-only|name-status|quiet|exit-code)\b/.test(cmd) || /\s--\s/.test(cmd)) return false;
  const rest = cmd.replace(/^git\s+diff\b/, '').split(/\s+/).filter(t => t && !t.startsWith('-'));
  return !rest.some(t => /[\\/.]/.test(t) && !t.includes('..'));
}
function handleBash(input, state, file) {
  const cmd = typeof input.command === 'string' ? input.command.trim() : '';
  if (!cmd || cmd.includes('fusion-jev') || /\|\s*(head|tail|wc|grep|rg)\b/.test(cmd)) return;
  const segments = cmd.split(/\s*(?:&&|;|\|\|)\s*/).map(s => s.trim());
  if (!segments.some(seg => NOISY.some(re => re.test(seg)) || isNoisyDiff(seg))) return;
  if (!bump(state, file, 'bash')) return;
  advise(`Fusion: this output may be long. Prefer fusion-jev run -- <program argv...> (global install) or npx -y fusion-jev@${pluginVersion()} run -- <program argv...>; PowerShell: '--'. Add --raw for small exact output.`);
}

function main(text) {
  const event = JSON.parse(text);
  if (!event || typeof event !== 'object') return;
  if (event.hook_event_name && event.hook_event_name !== 'PreToolUse') return;
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : null;
  if (!input) return;
  const file = statePath(event.session_id);
  const state = file ? loadState(file) : { denied: [], advised: {} };
  if (event.tool_name === 'Read') handleRead(input, event, state, file);
  else if (event.tool_name === 'Grep') handleGrep(input, state, file);
  else if (event.tool_name === 'Bash') handleBash(input, state, file);
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; if (data.length > 1 << 20) process.exit(0); });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try { main(data); } catch { /* fail open */ }
  process.exit(0);
});
