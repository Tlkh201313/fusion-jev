// Shared secret handling for captured evidence and workspace output.
// Every pattern is linear: whitespace classes never cross line breaks and bounded
// classes exclude their own terminators, so untrusted input cannot trigger ReDoS.

const FIXED_NAMES = 'TYPESAFE_API_KEY|JEV_API_KEY|TEAMOROUTER_API_KEY|OPENAI_API_KEY|FUSION_HTTP_BEARER_TOKEN';
// Conventional upper-case environment names, e.g. GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, DB_PASSWORD.
const ENV_NAME = '[A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|PASSWORD|PASSWD|CREDENTIALS)';
const LINE_PREFIX = '^([ \\t]*(?:export[ \\t]+|declare[ \\t]+-x[ \\t]+|set[ \\t]+)?';

const PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`${LINE_PREFIX}(?:${FIXED_NAMES})[ \\t]*[=:][ \\t]*)(?!\\[REDACTED\\])[^\\r\\n]+`, 'gim'), '$1[REDACTED]'],
  [new RegExp(`${LINE_PREFIX}${ENV_NAME}[ \\t]*[=:][ \\t]*)(?!\\[REDACTED\\])[^\\r\\n]+`, 'gm'), '$1[REDACTED]'],
  [new RegExp(`("(?:${FIXED_NAMES})"[ \\t]*[:=][ \\t]*")(?:\\\\.|[^"\\\\\\r\\n])*(")`, 'gi'), '$1[REDACTED]$2'],
  [new RegExp(`('(?:${FIXED_NAMES})'[ \\t]*[:=][ \\t]*')(?:\\\\.|[^'\\\\\\r\\n])*(')`, 'gi'), '$1[REDACTED]$2'],
  [new RegExp(`("${ENV_NAME}"[ \\t]*[:=][ \\t]*")(?:\\\\.|[^"\\\\\\r\\n])*(")`, 'g'), '$1[REDACTED]$2'],
  [new RegExp(`('${ENV_NAME}'[ \\t]*[:=][ \\t]*')(?:\\\\.|[^'\\\\\\r\\n])*(')`, 'g'), '$1[REDACTED]$2'],
  // Headers anywhere on a line, including curl -v "> Authorization:" and JSON header maps.
  [/(\b(?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic|token)[ \t]+)(?!\[REDACTED\])[^\s'",]+/gi, '$1[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,256}:)[^\s/@]{1,256}(@)/gi, '$1[REDACTED]$2'],
];

// High-confidence token shapes; safe to apply to source files as well as command output.
const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
// Private key blocks are blanked line by line so numbered excerpts keep their line count.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[^]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g;

// Values of credentials this process can see are redacted wherever they appear.
const SECRET_ENV = ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'TEAMOROUTER_API_KEY', 'OPENAI_API_KEY', 'FUSION_HTTP_BEARER_TOKEN',
  'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

function knownValues(): string[] {
  return SECRET_ENV.map(name => process.env[name]).filter((value): value is string => typeof value === 'string' && value.length >= 8);
}

/** Redact high-confidence token shapes and this process's own credential values. */
export function redactTokens(text: string): string {
  let safe = text;
  for (const value of knownValues()) if (safe.includes(value)) safe = safe.split(value).join('[REDACTED]');
  for (const pattern of TOKEN_SHAPES) safe = safe.replace(pattern, '[REDACTED]');
  return safe.replace(PRIVATE_KEY_BLOCK, block => block.replace(/[^\r\n]+/g, '[REDACTED]'));
}

/** Full redaction for captured output: assignments, headers, URL credentials and token shapes. */
export function redactSecrets(text: string): string {
  let safe = text;
  for (const [pattern, replacement] of PATTERNS) safe = safe.replace(pattern, replacement);
  return redactTokens(safe);
}

const SECRET_DIRS = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.codex', '.docker', '.kube', '.password-store']);
const SECRET_FILES = new Set(['.npmrc', '.git-credentials', '.netrc', '_netrc', '.pgpass', '.pypirc', '.dev.vars', '.yarnrc.yml',
  '.htpasswd', 'credentials.json', '.credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk'];

/** True for path components that commonly hold credentials (case-insensitive). */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || SECRET_DIRS.has(lower) || SECRET_FILES.has(lower)
    || SECRET_EXTENSIONS.some(extension => lower.endsWith(extension));
}

/** Glob exclusions for Git pathspecs matching isSecretName. */
export const SECRET_GLOBS = ['.env*', ...SECRET_DIRS, ...SECRET_FILES, ...SECRET_EXTENSIONS.map(extension => `*${extension}`)];
