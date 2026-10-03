/** Pure helpers for the workspace grep: pattern safety, glob matching and hit ranking. */

export const MAX_GREP_PATTERN_CHARS = 200;
const MAX_UNBOUNDED_QUANTIFIERS = 5;

export class UnsafePatternError extends Error {}

/**
 * Compile a user regex or explain why it is refused. JavaScript cannot interrupt a running regex, so this is a
 * conservative static screen (length, back-references, nested or alternated quantified groups, quantifier count)
 * combined with per-line length caps and a scan deadline in the caller. It is not a sandbox.
 */
export function compileSafeRegex(pattern: string, ignoreCase: boolean): RegExp {
  if (!pattern || pattern.length > MAX_GREP_PATTERN_CHARS) throw new UnsafePatternError(`Pattern must be 1-${MAX_GREP_PATTERN_CHARS} characters`);
  let regex: RegExp;
  try { regex = new RegExp(pattern, ignoreCase ? 'i' : ''); }
  catch { throw new UnsafePatternError('Invalid regular expression'); }
  if (/\\[1-9]|\\k</.test(pattern)) throw new UnsafePatternError('Back-references are not allowed');
  interface Frame { quantified: boolean; alternated: boolean }
  const frames: Frame[] = [{ quantified: false, alternated: false }];
  let unbounded = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    const top = frames[frames.length - 1]!;
    if (ch === '(') frames.push({ quantified: false, alternated: false });
    else if (ch === '|') top.alternated = true;
    else if (ch === '*' || ch === '+') { top.quantified = true; unbounded++; }
    else if (ch === '{') {
      const bound = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (bound) {
        const open = bound[2] !== undefined && bound[3] === '';
        const max = open ? Infinity : Number(bound[3] || bound[1]);
        if (open) unbounded++;
        if (max > 1) top.quantified = true;
        i += bound[0].length - 1;
      }
    } else if (ch === ')' && frames.length > 1) {
      const frame = frames.pop()!;
      const parent = frames[frames.length - 1]!;
      const next = pattern[i + 1];
      const repeats = next === '*' || next === '+' || (next === '{' && /^\{\d+,\d*\}/.test(pattern.slice(i + 1)) && !/^\{\d+(,1)?\}/.test(pattern.slice(i + 1)));
      if (repeats && (frame.quantified || frame.alternated))
        throw new UnsafePatternError('Quantified group containing a quantifier or alternation can backtrack catastrophically; simplify it or use the search action');
      if (frame.quantified || (repeats && frame.alternated)) parent.quantified = true;
      if (frame.alternated && repeats) parent.alternated = true;
    }
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) throw new UnsafePatternError(`Too many unbounded quantifiers (max ${MAX_UNBOUNDED_QUANTIFIERS})`);
  return regex;
}

/** Glob over workspace-relative paths: `**` crosses directories, `*` and `?` stay within one, `{a,b}` alternates. A slash-free glob matches the base name. */
export function globMatcher(glob: string): (path: string) => boolean {
  if (glob.length > 200) throw new UnsafePatternError('Glob is too long');
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*'; }
      else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else if (ch === '{') { const end = glob.indexOf('}', i); if (end < 0) source += '\\{'; else { source += `(?:${glob.slice(i + 1, end).split(',').map(escapeRegex).join('|')})`; i = end; } }
    else source += escapeRegex(ch);
  }
  const regex = new RegExp(`^${source}$`, 'i');
  const slashFree = !glob.includes('/');
  return path => regex.test(slashFree ? path.slice(path.lastIndexOf('/') + 1) : path);
}
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DEFINITION = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|sealed\s+|partial\s+|async\s+|unsafe\s+|extern\s+)*(?:function|class|interface|type|enum|struct|trait|impl|fn|func|def|const|let|var|record|namespace|module|mod|object|protocol|macro_rules!)\b/;
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);

export interface GrepHit { path: string; line: number; text: string; column: number; length: number; definition: boolean; exactWord: boolean; tier: number }

/** Classify one match: definition-looking lines and whole-word matches rank first. */
export function classifyHit(line: string, index: number, length: number): { definition: boolean; exactWord: boolean; tier: number } {
  const exactWord = length > 0 && !isWordChar(line[index - 1]) && !isWordChar(line[index + length]);
  const head = DEFINITION.exec(line);
  const definition = head !== null && index >= head[0].length && /^[\s*]*$/.test(line.slice(head[0].length, index));
  return { definition, exactWord, tier: (definition ? 2 : 0) + (exactWord ? 1 : 0) };
}

/** Definition and whole-word hits first, then a spread that shows each file's first hit before any file's second, then path and line. */
export function rankHits<T extends { path: string; line: number; tier: number }>(hits: T[]): T[] {
  const seen = new Map<string, number>();
  const ordinal = new Map<T, number>();
  for (const hit of [...hits].sort((a, b) => b.tier - a.tier || a.line - b.line)) {
    const key = `${hit.path}\0${hit.tier}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    ordinal.set(hit, count);
  }
  return [...hits].sort((a, b) => b.tier - a.tier || ordinal.get(a)! - ordinal.get(b)! || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
}
