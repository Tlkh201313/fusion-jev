// Keeps every shipped version string in step with package.json.
//
//   node scripts/sync-version.mjs                 rewrite the files below (runs from the npm "version" lifecycle)
//   node scripts/sync-version.mjs --check         fail if any file is out of sync (no writes)
//   node scripts/sync-version.mjs --check --tag v0.3.0
//                                                 also require the release tag (leading "v" stripped) to match
//
// Files are edited as text so existing formatting is preserved.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readPackageVersion() {
  const { version } = JSON.parse(read('package.json'));
  if (typeof version !== 'string' || !semver.test(version))
    throw new Error(`package.json has an invalid version: ${version}`);
  return version;
}

const jsonVersion = /("version"\s*:\s*")[^"]*(")/g;
const mcpPin = /("fusion-jev)(?:@[^"]*)?(")/;
const promptPin = /(npx -y fusion-jev@)[^\s`"]+/g;

// Host guidance that names the pinned `npx -y fusion-jev@<version> run` command: path -> expected pin count.
const promptPins = {
  'plugin/fusion-jev/plugin.json': 1,
  'plugin/fusion-jev/.codex-plugin/plugin.json': 1,
  'plugin/fusion-jev-claude/skills/assist/SKILL.md': 1,
};

// path -> [expected replacement count, rewrite(text, version)]
function targets(version) {
  const versionField = (count) => [count, (text) => text.replace(jsonVersion, `$1${version}$2`)];
  return {
    'server.json': versionField(2),
    'plugin/fusion-jev/plugin.json': versionField(1),
    'plugin/fusion-jev/.codex-plugin/plugin.json': versionField(1),
    'plugin/fusion-jev-claude/.claude-plugin/plugin.json': versionField(1),
    'plugin/fusion-jev/.mcp.json': [1, (text) => text.replace(mcpPin, `$1@${version}$2`)],
    'plugin/fusion-jev-claude/.mcp.json': [1, (text) => text.replace(mcpPin, `$1@${version}$2`)],
    'plugin/fusion-jev-claude/skills/assist/SKILL.md': [
      promptPins['plugin/fusion-jev-claude/skills/assist/SKILL.md'],
      (text) => text,
    ],
    'src/mcp/server.ts': [1, (text) => text.replace(/(title: 'Fusion Jev', version: ')[^']*(')/, `$1${version}$2`)],
  };
}

function occurrences(text, pattern) {
  return [
    ...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')),
  ].length;
}

export function syncVersions({ write }) {
  const version = readPackageVersion();
  const problems = [];
  const changed = [];
  for (const [path, [count, rewrite]] of Object.entries(targets(version))) {
    const before = read(path);
    const pattern = path.endsWith('.mcp.json')
      ? mcpPin
      : path.endsWith('SKILL.md')
        ? promptPin
        : path === 'src/mcp/server.ts'
          ? /title: 'Fusion Jev', version: '/
          : jsonVersion;
    if (occurrences(before, pattern) !== count) problems.push(`${path}: expected ${count} version field(s)`);
    let after = rewrite(before);
    if (path in promptPins) {
      if (!path.endsWith('SKILL.md') && occurrences(before, promptPin) !== promptPins[path])
        problems.push(`${path}: expected ${promptPins[path]} pinned npx command(s)`);
      after = after.replace(promptPin, `$1${version}`);
    }
    if (after !== before) {
      changed.push(path);
      if (write) writeFileSync(join(root, path), after);
    }
  }
  const lock = JSON.parse(read('package-lock.json'));
  for (const found of [lock.version, lock.packages?.['']?.version]) {
    if (found !== version)
      problems.push(
        `package-lock.json: version ${found} does not match package.json ${version} (run npm install --package-lock-only)`,
      );
  }
  return { version, changed, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const tagIndex = args.indexOf('--tag');
  const { version, changed, problems } = syncVersions({ write: !check });
  if (tagIndex >= 0) {
    const tag = args[tagIndex + 1];
    if (!tag) problems.push('--tag needs a value');
    else if (tag.replace(/^v/, '') !== version)
      problems.push(`tag ${tag} does not match package.json version ${version}`);
  }
  if (check)
    for (const path of changed) problems.push(`${path}: not at version ${version} (run node scripts/sync-version.mjs)`);
  if (problems.length) {
    process.stderr.write(`Version check failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    check
      ? `All versions match ${version}.\n`
      : `Synced to ${version}${changed.length ? `: ${changed.join(', ')}` : ' (already in sync)'}.\n`,
  );
}
