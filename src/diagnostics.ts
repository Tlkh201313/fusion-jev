export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'; message: string; file?: string; line?: number; column?: number;
  evidenceId: string; startByte: number; endByte: number;
}
export interface CheckSuggestion {
  sourcePath: string; label: string; argv: string[]; id: string; cwd: string; sourceSha256: string; requiresApproval: true;
}

const patterns = [
  /^not ok \d+ - (?<message>.+)$/,
  /^FAILED (?<file>.+?\.py)::\S+ - (?<message>.+)$/,
  /^--- FAIL: (?<message>\S+) \([\d.]+s\)$/,
  /^(?<file>.+?\.tsx?)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning|info)\s+TS\d+:\s*(?<message>.+)$/i,
  /^(?<file>.+?\.py):(?<line>\d+)(?::(?<column>\d+))?:\s*(?<message>[A-Za-z_]+(?:Error|Exception):\s*.+)$/,
  /^(?<file>.+?\.rs):(?<line>\d+):(?<column>\d+):\s*(?<severity>error|warning|info):\s*(?<message>.+)$/i,
  /^(?<file>.+?\.go):(?<line>\d+)(?::(?<column>\d+))?:\s*(?:(?<severity>error|warning|info):\s*)?(?<message>.+)$/i,
  /^(?<file>.+?\.(?:c|cc|cpp|cxx|h|hpp)):(?<line>\d+)(?::(?<column>\d+))?:\s*(?<severity>fatal error|error|warning|note):\s*(?<message>.+)$/i,
  /^(?<file>.+?\.[cm]?[jt]sx?):(?<line>\d+):(?<column>\d+)\s*(?:-|:)\s*(?<severity>error|warning|info)\s+TS\d+:\s*(?<message>.+)$/i,
];

export function parseDiagnostics(input: { text: string; sourceEvidenceId: string; tool?: string }): Diagnostic[] {
  return scanDiagnostics(input).diagnostics;
}

export function scanDiagnostics(input: { text: string; sourceEvidenceId: string; tool?: string }, maxDiagnostics = Number.POSITIVE_INFINITY): { diagnostics: Diagnostic[]; total: number } {
  const found: Diagnostic[] = [];
  let total = 0;
  const add = (diagnostic: Diagnostic) => { total++; if (found.length < maxDiagnostics) found.push(diagnostic); };
  let startByte = 0;
  const lines = input.text.split(/(?<=\n)/);
  for (const [index, line] of lines.entries()) {
    const body = line.replace(/\r?\n$/, '');
    if (/^not ok \d+ - .*#\s*(?:TODO|SKIP)\b/i.test(body)) { startByte += Buffer.byteLength(line); continue; }
    const next = lines[index + 1]?.replace(/\r?\n$/, '') ?? '';
    const node = /^Error:\s*(.+)$/.exec(body);
    const nodeLocation = /^\s+at .+\((.+):(\d+):(\d+)\)$/.exec(next);
    if (node && nodeLocation) {
      add({ severity: 'error', message: node[1]!, file: nodeLocation[1], line: Number(nodeLocation[2]),
        column: Number(nodeLocation[3]), evidenceId: input.sourceEvidenceId,
        startByte, endByte: startByte + Buffer.byteLength(body) });
      startByte += Buffer.byteLength(line);
      continue;
    }
    const rust = /^error(?:\[[^\]]+\])?:\s*(.+)$/.exec(body);
    const rustLocation = /^\s*-->\s*(.+\.rs):(\d+):(\d+)$/.exec(next);
    if (rust && rustLocation) {
      add({ severity: 'error', message: rust[1]!, file: rustLocation[1], line: Number(rustLocation[2]),
        column: Number(rustLocation[3]), evidenceId: input.sourceEvidenceId,
        startByte, endByte: startByte + Buffer.byteLength(body) });
      startByte += Buffer.byteLength(line);
      continue;
    }
    for (const pattern of patterns) {
      const match = pattern.exec(body);
      if (!match?.groups) continue;
      const groups = match.groups;
      const rawSeverity = groups.severity?.toLowerCase();
      const severity = rawSeverity === 'warning' ? 'warning' : rawSeverity === 'info' || rawSeverity === 'note' ? 'info' : 'error';
      add({ severity, message: groups.message!, file: groups.file,
        ...(groups.line ? { line: Number(groups.line) } : {}), ...(groups.column ? { column: Number(groups.column) } : {}),
        evidenceId: input.sourceEvidenceId, startByte, endByte: startByte + Buffer.byteLength(body) });
      break;
    }
    startByte += Buffer.byteLength(line);
  }
  return { diagnostics: found, total };
}

export function discoverChecks(root: string, manifest: ReadonlyArray<{ path: string; content: string }>): CheckSuggestion[] {
  const checks: CheckSuggestion[] = [];
  for (const { path, content } of manifest) {
    const name = basename(path);
    if (!['package.json', 'pyproject.toml', 'pytest.ini', 'Cargo.toml', 'go.mod', 'CMakeLists.txt', 'Makefile'].includes(name)) continue;
    const sourceSha256 = createHash('sha256').update(content).digest('hex');
    const add = (label: string, argv: string[]) => checks.push({ sourcePath: path, label, argv,
      cwd: resolve(root, dirname(path)), sourceSha256, requiresApproval: true,
      id: createHash('sha256').update(JSON.stringify([path, sourceSha256, argv])).digest('hex').slice(0, 24) });
    if (name === 'package.json') {
      try {
        const data = JSON.parse(content);
        const declared = /^(npm|pnpm|yarn|bun)@/.exec(typeof data.packageManager === 'string' ? data.packageManager : '')?.[1];
        const folder = dirname(path);
        const lock = (file: string) => manifest.some(item => dirname(item.path) === folder && basename(item.path) === file);
        const locked = [lock('pnpm-lock.yaml') ? 'pnpm' : undefined, lock('yarn.lock') ? 'yarn' : undefined,
          lock('bun.lock') || lock('bun.lockb') ? 'bun' : undefined, lock('package-lock.json') ? 'npm' : undefined].filter(Boolean);
        // Conflicting lockfiles require host judgment unless packageManager resolves the ambiguity.
        if (!declared && locked.length > 1) continue;
        const manager = declared ?? locked[0] ?? 'npm';
        const scripts = data.scripts;
        if (scripts && typeof scripts === 'object') for (const [name, value] of Object.entries(scripts))
          if (typeof value === 'string' && /^(?:test|check|lint|typecheck|build)(?::.*)?$/.test(name)) add(`${manager} ${name}`, [manager as string, 'run', name]);
      } catch { /* Invalid manifest gives no suggestions. */ }
    } else if (name === 'pyproject.toml') { if (/^\[tool\.pytest(?:\.ini_options)?\]/m.test(content)) add('pytest', ['pytest']); }
    else if (name === 'pytest.ini') { if (/^\[pytest\]/m.test(content)) add('pytest', ['pytest']); }
    else if (name === 'Cargo.toml') { if (/^\[package\]/m.test(content)) add('cargo test', ['cargo', 'test']); }
    else if (name === 'go.mod') { if (/^module\s+\S+/m.test(content)) add('go test', ['go', 'test', './...']); }
    else if (name === 'CMakeLists.txt') { if (/\bproject\s*\(/i.test(content)) add('ctest (host selects configured build directory)', ['ctest']); }
    else if (name === 'Makefile') { if (/^test\s*:/m.test(content)) add('make test', ['make', 'test']); }
  }
  return checks;
}
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

