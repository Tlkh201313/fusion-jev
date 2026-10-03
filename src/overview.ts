import { posix } from 'node:path';

export interface EvidenceBlock { label: string; text: string }

/** Preserve complete evidence whenever it fits; otherwise share the budget fairly. */
export function fitBlocks(blocks: EvidenceBlock[], maxChars: number) {
  const complete = blocks.map(block => `[${block.label}]\n${block.text}`).join('\n\n');
  if (complete.length <= maxChars) return { text: complete, clipped: [] as string[] };
  const note = '\nOUTPUT LIMITED: request this section directly for more.';
  const headers = blocks.reduce((sum, block) => sum + block.label.length + 3, 2 * (blocks.length - 1));
  let spare = Math.max(0, maxChars - headers - note.length * blocks.length);
  const allowances = blocks.map(() => 0);
  let active = blocks.map((_, i) => i);
  while (spare > 0 && active.length) {
    const share = Math.max(1, Math.floor(spare / active.length));
    for (const i of active) {
      const added = Math.min(share, blocks[i]!.text.length - allowances[i]!, spare);
      allowances[i]! += added;
      spare -= added;
    }
    active = active.filter(i => allowances[i]! < blocks[i]!.text.length);
  }
  const clipped: string[] = [];
  const text = blocks.map((block, i) => {
    let body = block.text;
    if (body.length > allowances[i]!) {
      const boundary = body.lastIndexOf('\n', allowances[i]!);
      body = body.slice(0, boundary > 0 ? boundary : allowances[i]);
      body += note;
      clipped.push(block.label);
    }
    return `[${block.label}]\n${body}`;
  }).join('\n\n');
  // Very long filenames alone can exhaust a small budget.
  return text.length <= maxChars ? { text, clipped }
    : { text: text.slice(0, Math.max(0, maxChars - note.length)) + note, clipped: blocks.map(block => block.label) };
}

/** Mask comments and literal bodies, retaining offsets, lines and quoted-string boundaries. */
function maskLiterals(source: string): string {
  const chars = source.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const start = i;
    if (source.startsWith('//', i)) {
      i = source.indexOf('\n', i);
      if (i < 0) i = source.length;
      blank(start, i);
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      blank(start, i);
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i++]!;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      const closed = i < source.length;
      i = Math.min(source.length, i + 1);
      blank(quote === '`' ? start : start + 1, quote === '`' || !closed ? i : i - 1);
    } else i++;
  }
  return chars.join('');
}

export interface DependencyEdge { from: string; to: string; line: number; kind: 'import' | 'type' | 're-export' }

/** Bounded static JS/TS module dependencies, not a runtime call graph or full parser. */
export function dependencyEdges(path: string, lines: Array<{ number: number; text: string }>, discovered: Set<string>) {
  const edges: DependencyEdge[] = [];
  if (!/\.[cm]?[jt]sx?$/i.test(path)) return { supported: false, edges, unresolved: 0 };
  const source = lines.map(line => line.text).join('\n');
  const masked = maskLiterals(source);
  const name = '[A-Za-z_$][\\w$]*';
  const named = '\\{[\\w$,\\s]*\\}';
  const namespace = `\\*(?:\\s+as\\s+${name})?`;
  const bindings = `(?:${name}(?:\\s*,\\s*(?:${named}|${namespace}))?|${named}|${namespace})`;
  const declarations = [
    new RegExp(`^[ \\t]*(import|export)\\s+(?:(type)\\s+)?(${bindings})\\s+from\\s+(["'])([^"'\\r\\n]*)\\4`, 'gmd'),
    /^[ \t]*(import)()()\s+(["'])([^"'\r\n]*)\4/gmd,
  ];
  let unresolved = 0;
  const matches = declarations.flatMap(pattern => [...masked.matchAll(pattern)]).sort((a, b) => a.index - b.index);
  for (const match of matches) {
    const range = match.indices![5]!;
    const specifier = source.slice(range[0], range[1]);
    // Escaped specifiers need a real language parser; do not invent an edge.
    if (!specifier.startsWith('.') || specifier.includes('\\')) continue;
    const base = posix.normalize(posix.join(posix.dirname(path), specifier));
    const alternatives = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'].map(ext => base + ext),
      ...['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'].map(ext => `${base}/index.${ext}`)];
    if (/\.[cm]?jsx?$/.test(base)) alternatives.push(base.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'));
    const to = alternatives.find(candidate => discovered.has(candidate));
    if (!to) { unresolved++; continue; }
    const line = (lines[0]?.number ?? 1) + source.slice(0, match.index).split('\n').length - 1;
    const inlineBindings = match[3]!.startsWith('{') ? match[3]!.slice(1, -1).split(',').filter(item => item.trim()) : [];
    const onlyInlineTypes = inlineBindings.length > 0 && inlineBindings.every(item => /^\s*type\s+/.test(item));
    const kind = match[2] || onlyInlineTypes ? 'type' : match[1] === 'export' ? 're-export' : 'import';
    if (!edges.some(edge => edge.to === to && edge.kind === kind)) edges.push({ from: path, to, line, kind });
  }
  return { supported: true, edges, unresolved };
}

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Source files behind package.json `bin`, `main`, `module`, `types` and `exports` targets, in that order.
 * Built targets such as `dist/cli.js` map back to `src/cli.ts` when that file was discovered.
 */
export function manifestEntryPoints(manifest: string, discovered: Iterable<string>): string[] {
  let json: any;
  try { json = JSON.parse(manifest); } catch { return []; }
  if (!json || typeof json !== 'object') return [];
  const targets: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') targets.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(typeof json.bin === 'string' ? json.bin : json.bin && typeof json.bin === 'object' ? Object.values(json.bin) : undefined);
  for (const key of ['main', 'module', 'exports', 'types', 'typings']) collect(json[key]);
  const known = new Set(discovered);
  const entries: string[] = [];
  for (const target of targets) {
    const relative = posix.normalize(target.replace(/\\/g, '/')).replace(/^\.\//, '');
    if (relative.startsWith('..') || relative.startsWith('/')) continue;
    const stem = relative.replace(/\.d\.[cm]?ts$/, '').replace(/\.[^./]+$/, '');
    const stems = [stem, stem.replace(/^(?:dist|build|lib|out)\//, 'src/')];
    const match = stems.flatMap(item => [item, ...sourceExtensions.map(ext => item + ext)]).find(candidate => known.has(candidate));
    if (match && !entries.includes(match)) entries.push(match);
  }
  return entries;
}

const conventionalEntryStems = ['index', 'main', 'app', 'server', 'cli', 'mcp', 'router', 'workspace', 'validation', 'executor', 'config', 'oauth', 'jev', 'gpt', 'types'];

/** Order sources so manifest entry points come first, then conventional entry/core names, then the rest by path. */
export function rankSources(paths: string[], entryPoints: string[] = []): string[] {
  const rank = (path: string) => {
    const entry = entryPoints.indexOf(path);
    if (entry >= 0) return entry - entryPoints.length;
    const stem = (path.split('/').at(-1) ?? path).replace(/\.[^.]+$/, '').toLowerCase();
    const index = conventionalEntryStems.indexOf(stem);
    return index < 0 ? 100 : index;
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * One row per importing file. With `maxEdgesPerRow`, hub files (barrels) show their first edges and a count,
 * so a single wide row cannot consume the budget meant for the whole module map.
 */
export function renderDependencyRows(rows: Array<{ path: string; edges: DependencyEdge[] }>, maxEdgesPerRow?: number): string {
  return rows.filter(row => row.edges.length).map(row => {
    const shown = maxEdgesPerRow === undefined ? row.edges : row.edges.slice(0, maxEdgesPerRow);
    const more = row.edges.length - shown.length;
    return `${row.path} -> ${shown.map(edge => `${edge.to}:${edge.line}${edge.kind === 'import' ? '' : ` (${edge.kind})`}`).join(', ')}`
      + (more > 0 ? ` (+${more} more)` : '');
  }).join('\n');
}
