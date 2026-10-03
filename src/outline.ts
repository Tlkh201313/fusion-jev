/**
 * Regex-based, index-free source outlines. The scanner is line-streaming: feed lines in order, then finish().
 * Symbol ends come from brace depth (C-like languages) or indentation (Python), so ranges are heuristic:
 * strings, comments and regex literals are masked, but macros, unusual formatting and unbraced declarations
 * can give approximate ends. Such symbols are flagged `approx`.
 */
export type OutlineLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'csharp' | 'markdown';
export interface OutlineSymbol {
  kind: string; name: string; startLine: number; endLine: number; exported: boolean;
  /** Enclosing symbol name for members (class, impl, namespace). */
  parent?: string; /** True when the end line was inferred without a closing brace or dedent. */ approx?: boolean;
}
export interface OutlineResult { language: OutlineLanguage; symbols: OutlineSymbol[]; totalLines: number }

const EXTENSIONS: Array<[RegExp, OutlineLanguage]> = [
  [/\.(?:ts|tsx|mts|cts)$/i, 'typescript'], [/\.(?:js|jsx|mjs|cjs)$/i, 'javascript'], [/\.pyi?$/i, 'python'],
  [/\.go$/i, 'go'], [/\.rs$/i, 'rust'], [/\.java$/i, 'java'], [/\.cs$/i, 'csharp'], [/\.(?:md|markdown)$/i, 'markdown'],
];
export function outlineLanguage(path: string): OutlineLanguage | undefined {
  return EXTENSIONS.find(([pattern]) => pattern.test(path))?.[1];
}

const CONTAINERS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'impl', 'namespace', 'module', 'record']);
const NAME = '[A-Za-z_$][\\w$]*';
const CONTROL = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'function', 'new', 'super', 'await', 'typeof',
  'using', 'lock', 'fixed', 'nameof', 'throw', 'sizeof', 'else', 'do', 'try', 'when', 'synchronized', 'this', 'base']);

interface Decl { kind: string; name: string; exported: boolean }
type Matcher = (code: string, parent: Open | undefined) => Decl | undefined;

const isUpper = (name: string) => /^\p{Lu}/u.test(name);

// ---- declaration matchers -------------------------------------------------------------------

const tsModifiers = '((?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare|accessor)\\s+)*)';
const tsMember = new RegExp(`^\\s*${tsModifiers}\\*?\\s*(#?${NAME})\\s*(?:<[^>()]*>)?\\s*\\(`);
const tsArrowMember = new RegExp(`^\\s*${tsModifiers}(#?${NAME})\\s*(?::[^=]*?)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|${NAME})\\s*(?::[^=]*?)?=>`);
const matchTs: Matcher = (code, parent) => {
  if (parent && parent.sym.kind !== 'namespace') {
    if (parent.sym.kind !== 'class') return undefined;
    const member = tsMember.exec(code) ?? tsArrowMember.exec(code);
    if (!member || CONTROL.has(member[2]!)) return undefined;
    const name = member[2]!;
    return { kind: 'method', name, exported: !/\b(?:private|protected)\b/.test(member[1]!) && !name.startsWith('#') };
  }
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^\\s*(export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${NAME})`).exec(code))) return { kind: 'class', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*(export\\s+)?(?:declare\\s+)?interface\\s+(${NAME})`).exec(code))) return { kind: 'interface', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*(export\\s+)?(?:declare\\s+)?type\\s+(${NAME})\\s*[<=]`).exec(code))) return { kind: 'type', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*(export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${NAME})`).exec(code))) return { kind: 'enum', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*(export\\s+)?(?:declare\\s+)?(?:namespace|module)\\s+(${NAME}(?:\\.${NAME})*)`).exec(code))) return { kind: 'namespace', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*(export\\s+)?(default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\b\\s*\\*?\\s*(${NAME})?`).exec(code))) {
    const name = m[3] ?? (m[2] ? 'default' : undefined);
    return name ? { kind: 'function', name, exported: !!m[1] } : undefined;
  }
  if ((m = new RegExp(`^\\s*(export\\s+)?(?:const|let|var)\\s+(${NAME})\\s*(?::.*?)?=(?![=>])\\s*(.*)$`).exec(code))) {
    const rhs = m[3]!;
    const callable = new RegExp(`^(?:async\\b|function\\b|\\(|<|${NAME}\\s*=>)`).test(rhs);
    if (callable) return { kind: 'function', name: m[2]!, exported: !!m[1] };
    return m[1] ? { kind: 'const', name: m[2]!, exported: true } : undefined;
  }
  return undefined;
};

const matchGo: Matcher = code => {
  let m: RegExpExecArray | null;
  if ((m = /^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)/.exec(code)))
    return { kind: m[1] ? 'method' : 'function', name: m[1] ? `${m[1]}.${m[2]}` : m[2]!, exported: isUpper(m[2]!) };
  if ((m = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/.exec(code))) return { kind: m[2]!, name: m[1]!, exported: isUpper(m[1]!) };
  if ((m = /^type\s+([A-Za-z_]\w*)\b/.exec(code))) return { kind: 'type', name: m[1]!, exported: isUpper(m[1]!) };
  if ((m = /^(const|var)\s+([A-Za-z_]\w*)\b/.exec(code))) return { kind: m[1]!, name: m[2]!, exported: isUpper(m[2]!) };
  return undefined;
};

const rustVis = '(pub(?:\\([^)]*\\))?\\s+)?';
function implName(code: string): string | undefined {
  const head = /^\s*(?:unsafe\s+)?impl\b/.exec(code);
  if (!head) return undefined;
  let rest = code.slice(head[0].length).trim();
  if (rest.startsWith('<')) {
    let depth = 0, i = 0;
    for (; i < rest.length; i++) { if (rest[i] === '<') depth++; else if (rest[i] === '>' && --depth === 0) break; }
    rest = rest.slice(i + 1).trim();
  }
  const name = rest.replace(/\s*(?:where\b.*|\{.*)?$/, '').trim();
  return name || undefined;
}
const matchRust: Matcher = (code, parent) => {
  const implParent = parent?.sym.kind === 'impl' || parent?.sym.kind === 'trait';
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^\\s*${rustVis}(?:(?:default|const|async|unsafe|extern(?:\\s+"[^"]*")?)\\s+)*fn\\s+(${NAME})`).exec(code)))
    return { kind: implParent ? 'method' : 'function', name: m[2]!, exported: !!m[1] || parent?.sym.kind === 'trait' || /\sfor\s/.test(parent?.sym.name ?? '') };
  if (parent && parent.sym.kind !== 'module') return undefined;
  if ((m = new RegExp(`^\\s*${rustVis}(?:unsafe\\s+)?(struct|enum|trait|union)\\s+(${NAME})`).exec(code))) return { kind: m[2]!, name: m[3]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*${rustVis}mod\\s+(${NAME})`).exec(code))) return { kind: 'module', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*${rustVis}type\\s+(${NAME})`).exec(code))) return { kind: 'type', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*${rustVis}(?:const|static)\\s+(?:mut\\s+)?(${NAME})\\s*:`).exec(code))) return { kind: 'const', name: m[2]!, exported: !!m[1] };
  if ((m = new RegExp(`^\\s*macro_rules!\\s*(${NAME})`).exec(code))) return { kind: 'macro', name: m[1]!, exported: false };
  const impl = implName(code);
  return impl ? { kind: 'impl', name: impl, exported: false } : undefined;
};

const javaMods = '((?:(?:public|protected|private|abstract|static|final|sealed|non-sealed|strictfp|synchronized|native|default)\\s+)*)';
const javaType = new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*${javaMods}(class|interface|enum|record|@interface)\\s+(${NAME})`);
const javaMethod = new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*${javaMods}(?:<[^>]+>\\s+)?(?:[\\w.$]+(?:<[^()]*?>)?(?:\\[\\])*\\s+)?(${NAME})\\s*\\(`);
const bareCall = new RegExp(`^\\s*${NAME}\\s*\\(`);
const matchJava: Matcher = (code, parent) => {
  const owner = parent?.sym;
  const inInterface = owner?.kind === 'interface';
  let m = javaType.exec(code);
  if (m) return { kind: m[2] === '@interface' ? 'interface' : m[2]!, name: m[3]!, exported: (/\bpublic\b/.test(m[1]!) || inInterface) && (owner?.exported ?? true) };
  if (!owner || !CONTAINERS.has(owner.kind)) return undefined;
  m = javaMethod.exec(code);
  if (!m || CONTROL.has(m[2]!)) return undefined;
  // Enum constants such as `RED(1),` look like calls; real methods carry a modifier or return type.
  if (owner.kind === 'enum' && bareCall.test(code)) return undefined;
  return { kind: 'method', name: m[2]!, exported: (/\bpublic\b/.test(m[1]!) || (inInterface && !/\bprivate\b/.test(m[1]!))) && owner.exported };
};

const csMods = '((?:(?:public|internal|protected|private|static|abstract|virtual|override|sealed|async|extern|unsafe|partial|new|readonly|file|ref)\\s+)*)';
const csType = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${csMods}(class|interface|struct|enum|record(?:\\s+(?:class|struct))?|delegate\\s+[\\w<>\\[\\].?]+)\\s+(${NAME})`);
const csMethod = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${csMods}(?:[\\w.<>\\[\\],?]+\\s+)?(${NAME})\\s*(?:<[^()]*>)?\\s*\\(`);
const csProperty = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${csMods}[\\w.<>\\[\\],?]+\\s+(${NAME})\\s*(?:\\{|=>)`);
const matchCs: Matcher = (code, parent) => {
  const owner = parent?.sym;
  const ns = /^\s*namespace\s+([\w.]+)/.exec(code);
  if (ns) return { kind: 'namespace', name: ns[1]!, exported: true };
  const visible = (mods: string, inInterface: boolean) => (/\b(?:public|protected)\b/.test(mods) || (inInterface && !/\bprivate\b/.test(mods))) && (owner?.exported ?? true);
  const type = csType.exec(code);
  if (type) return { kind: type[2]!.split(/\s/)[0]!, name: type[3]!, exported: /\bpublic\b/.test(type[1]!) && (owner?.exported ?? true) };
  if (!owner || !CONTAINERS.has(owner.kind) || owner.kind === 'namespace') return undefined;
  const inInterface = owner.kind === 'interface';
  const method = csMethod.exec(code);
  if (method && !CONTROL.has(method[2]!)) return { kind: 'method', name: method[2]!, exported: visible(method[1]!, inInterface) };
  const property = csProperty.exec(code);
  if (property && !CONTROL.has(property[2]!) && (/\b(?:public|protected|internal|private)\b/.test(property[1]!) || inInterface))
    return { kind: 'property', name: property[2]!, exported: visible(property[1]!, inInterface) };
  return undefined;
};

// ---- lexical masking ------------------------------------------------------------------------

interface Lex { block: boolean; template: boolean }
/** Blank out comments and string/char/regex bodies so brace and paren counting only sees code. */
function maskLine(text: string, lex: Lex, language: OutlineLanguage): string {
  const jsLike = language === 'typescript' || language === 'javascript';
  const backtick = jsLike || language === 'go';
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (lex.block) {
      const end = text.indexOf('*/', i);
      if (end < 0) return out;
      lex.block = false; i = end + 2; out += ' ';
      continue;
    }
    if (lex.template) {
      while (i < n && text[i] !== '`') i += text[i] === '\\' && jsLike ? 2 : 1;
      if (i >= n) return out;
      lex.template = false; i++; out += '`';
      continue;
    }
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '/' && next === '/') return out;
    if (ch === '/' && next === '*') { lex.block = true; i += 2; continue; }
    if (ch === '"' || ch === "'") {
      if (language === 'rust' && ch === "'" && !/^'(?:\\.[^']*|[^\\'])'/.test(text.slice(i))) { out += ch; i++; continue; }
      let j = i + 1;
      while (j < n && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      out += ch + ' '.repeat(Math.max(0, Math.min(j, n) - i - 1)) + (j < n ? ch : '');
      i = j + 1;
      continue;
    }
    if (ch === '`' && backtick) { lex.template = true; i++; out += '`'; continue; }
    if (ch === '/' && jsLike && /[(,=:[!&|?{};]$|^$/.test(out.trimEnd().slice(-1))) {
      // Regex literal: skip to the closing slash, honouring escapes and character classes.
      let j = i + 1, inClass = false;
      while (j < n && (text[j] !== '/' || inClass)) { if (text[j] === '\\') j++; else if (text[j] === '[') inClass = true; else if (text[j] === ']') inClass = false; j++; }
      if (j < n) { out += '/' + ' '.repeat(j - i - 1) + '/'; i = j + 1; continue; }
    }
    out += ch; i++;
  }
  return out;
}

// ---- brace-language scanner -----------------------------------------------------------------

interface Open { sym: OutlineSymbol; startDepth: number; opened: boolean }
class BraceScanner {
  readonly symbols: OutlineSymbol[] = [];
  private readonly stack: Open[] = [];
  private readonly lex: Lex = { block: false, template: false };
  private brace = 0;
  private paren = 0;
  private lastCode = 0;
  private lines = 0;
  constructor(private readonly language: OutlineLanguage, private readonly matcher: Matcher) {}

  push(text: string, number: number): void {
    this.lines = number;
    const wasTemplate = this.lex.template || this.lex.block;
    const code = maskLine(text, this.lex, this.language);
    const meaningful = code.trim().length > 0;
    if (meaningful && !wasTemplate && this.paren === 0) this.detect(code, number);
    const top = () => this.stack[this.stack.length - 1];
    for (const ch of code) {
      if (ch === '(') this.paren++;
      else if (ch === ')') this.paren = Math.max(0, this.paren - 1);
      else if (ch === '{') {
        const current = top();
        if (current && !current.opened && this.paren === 0 && this.brace === current.startDepth) current.opened = true;
        this.brace++;
      } else if (ch === '}') {
        this.brace = Math.max(0, this.brace - 1);
        for (let current = top(); current; current = top()) {
          if (current.opened && this.brace <= current.startDepth) { current.sym.endLine = number; this.stack.pop(); }
          else if (!current.opened && this.brace < current.startDepth) { this.closeLoose(current); this.stack.pop(); }
          else break;
        }
      } else if (ch === ';' && this.paren === 0) {
        const current = top();
        if (current && !current.opened && this.brace === current.startDepth) { current.sym.endLine = number; this.stack.pop(); }
      }
    }
    if (meaningful) this.lastCode = number;
    // Go has no terminators: a balanced, unopened one-line declaration ends with its line.
    const current = top();
    if (this.language === 'go' && !this.lex.template && current && !current.opened && this.paren === 0 && this.brace === current.startDepth && meaningful
      && !/[,(\[{+\-*/&|=.:<>]\s*$/.test(code)) { current.sym.endLine = number; this.stack.pop(); }
  }

  private closeLoose(open: Open): void {
    open.sym.endLine = Math.max(open.sym.startLine, this.lastCode);
    open.sym.approx = true;
  }

  private detect(code: string, number: number): void {
    const top = this.stack[this.stack.length - 1];
    // A nested statement (not a direct member of a container) never starts a symbol.
    const topLevel = this.brace === 0 && !top;
    const member = top?.opened && CONTAINERS.has(top.sym.kind) && this.brace === top.startDepth + 1;
    const loose = top && !top.opened && this.brace === top.startDepth;
    if (!topLevel && !member && !loose) return;
    const owner = loose ? this.stack[this.stack.length - 2] : top;
    const ownerForMatch = owner && owner.opened && CONTAINERS.has(owner.sym.kind) && this.brace === owner.startDepth + 1 ? owner : undefined;
    const decl = this.matcher(code, ownerForMatch);
    if (!decl) return;
    if (loose && top) { this.closeLoose(top); this.stack.pop(); }
    const sym: OutlineSymbol = { kind: decl.kind, name: decl.name, startLine: number, endLine: number, exported: decl.exported,
      ...(ownerForMatch ? { parent: ownerForMatch.sym.name } : {}) };
    this.symbols.push(sym);
    this.stack.push({ sym, startDepth: this.brace, opened: false });
  }

  finish(totalLines: number): OutlineSymbol[] {
    while (this.stack.length) {
      const open = this.stack.pop()!;
      open.sym.endLine = Math.max(open.sym.startLine, open.opened ? totalLines : this.lastCode);
      open.sym.approx = true;
    }
    return this.symbols;
  }
}

// ---- Python (indentation) -------------------------------------------------------------------

class PythonScanner {
  readonly symbols: OutlineSymbol[] = [];
  private readonly stack: Array<{ sym: OutlineSymbol; indent: number }> = [];
  private triple: string | null = null;
  private paren = 0;
  private lastCode = 0;

  push(text: string, number: number): void {
    if (this.triple) {
      this.lastCode = number;
      this.consumeTriples(text);
      return;
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (this.paren > 0) { this.lastCode = number; this.track(text); return; }
    const indent = text.length - text.trimStart().length + (text.match(/^\t*/)?.[0].length ?? 0) * 3;
    while (this.stack.length && indent <= this.stack[this.stack.length - 1]!.indent) {
      this.stack.pop()!.sym.endLine = this.lastCode;
    }
    const top = this.stack[this.stack.length - 1];
    const m = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(text);
    if (m && (!top || top.sym.kind === 'class')) {
      const name = m[2]!;
      const isClass = m[1] === 'class';
      const sym: OutlineSymbol = { kind: isClass ? 'class' : top ? 'method' : 'function', name, startLine: number, endLine: number,
        exported: !name.startsWith('_') || /^__\w+__$/.test(name) && !!top, ...(top ? { parent: top.sym.name } : {}) };
      if (top && !top.sym.exported) sym.exported = false;
      this.symbols.push(sym);
      this.stack.push({ sym, indent });
    }
    this.lastCode = number;
    this.track(text);
  }

  private consumeTriples(text: string): void {
    const quote = this.triple!;
    const count = text.split(quote).length - 1;
    if (count % 2 === 1) this.triple = null;
  }

  private track(text: string): void {
    const stripped = text.replace(/#.*$/, '');
    let quoteState: string | null = null;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i]!;
      if (this.triple) {
        if (stripped.startsWith(this.triple, i)) { this.triple = null; i += 2; }
        continue;
      }
      if (quoteState) { if (ch === '\\') i++; else if (ch === quoteState) quoteState = null; continue; }
      if (stripped.startsWith('"""', i) || stripped.startsWith("'''", i)) { this.triple = stripped.slice(i, i + 3); i += 2; continue; }
      if (ch === '"' || ch === "'") { quoteState = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') this.paren++;
      else if (ch === ')' || ch === ']' || ch === '}') this.paren = Math.max(0, this.paren - 1);
    }
  }

  finish(): OutlineSymbol[] {
    for (const open of this.stack.splice(0)) open.sym.endLine = Math.max(open.sym.startLine, this.lastCode);
    return this.symbols;
  }
}

// ---- Markdown headings ----------------------------------------------------------------------

class MarkdownScanner {
  readonly symbols: OutlineSymbol[] = [];
  private readonly levels: number[] = [];
  private fence = false;
  private lastLine = 0;
  push(text: string, number: number): void {
    this.lastLine = number;
    if (/^\s*(?:```|~~~)/.test(text)) { this.fence = !this.fence; return; }
    if (this.fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (!m) return;
    const level = m[1]!.length;
    for (let i = this.symbols.length - 1; i >= 0; i--) {
      if (this.levels[i]! >= level && this.symbols[i]!.endLine === Number.MAX_SAFE_INTEGER) this.symbols[i]!.endLine = number - 1;
    }
    this.symbols.push({ kind: 'heading', name: m[2]!.slice(0, 80), startLine: number, endLine: Number.MAX_SAFE_INTEGER, exported: level <= 2 });
    this.levels.push(level);
  }
  finish(): OutlineSymbol[] {
    for (const sym of this.symbols) if (sym.endLine === Number.MAX_SAFE_INTEGER) sym.endLine = Math.max(sym.startLine, this.lastLine);
    return this.symbols;
  }
}

// ---- public API -----------------------------------------------------------------------------

export class OutlineBuilder {
  private readonly scanner: BraceScanner | PythonScanner | MarkdownScanner;
  private total = 0;
  constructor(readonly language: OutlineLanguage) {
    const matchers: Partial<Record<OutlineLanguage, Matcher>> = {
      typescript: matchTs, javascript: matchTs, go: matchGo, rust: matchRust, java: matchJava, csharp: matchCs,
    };
    this.scanner = language === 'python' ? new PythonScanner() : language === 'markdown' ? new MarkdownScanner()
      : new BraceScanner(language, matchers[language]!);
  }
  push(text: string, number: number): void {
    this.total = number;
    // A pathological minified line must not dominate matching time.
    this.scanner.push(text.length > 2000 ? text.slice(0, 2000) : text, number);
  }
  finish(totalLines = this.total): OutlineResult {
    const symbols = this.scanner instanceof BraceScanner ? this.scanner.finish(totalLines) : this.scanner.finish();
    return { language: this.language, symbols, totalLines };
  }
}

export function buildOutline(language: OutlineLanguage, lines: Iterable<string>): OutlineResult {
  const builder = new OutlineBuilder(language);
  let number = 0;
  for (const line of lines) builder.push(line, ++number);
  return builder.finish(number);
}

/** Exported symbols first (each group in line order); members follow their parent. */
export function orderSymbols(symbols: OutlineSymbol[]): OutlineSymbol[] {
  const members = new Map<string, OutlineSymbol[]>();
  const roots: OutlineSymbol[] = [];
  for (const sym of symbols) {
    const owner = sym.parent ? symbols.find(item => item.name === sym.parent && item.startLine < sym.startLine && item.endLine >= sym.startLine) : undefined;
    if (owner) { const key = `${owner.name}:${owner.startLine}`; members.set(key, [...(members.get(key) ?? []), sym]); }
    else roots.push(sym);
  }
  const ordered: OutlineSymbol[] = [];
  for (const group of [roots.filter(sym => sym.exported), roots.filter(sym => !sym.exported)])
    for (const root of group) ordered.push(root, ...(members.get(`${root.name}:${root.startLine}`) ?? []));
  return ordered;
}

/** One compact row per symbol: `start-end kind name`, members indented, `~` marks an inferred end. */
export function renderSymbols(symbols: OutlineSymbol[], limit = 400): string[] {
  const rows: string[] = [];
  let section = '';
  for (const sym of orderSymbols(symbols)) {
    if (rows.length >= limit) { rows.push(`... ${symbols.length - limit} more symbols`); break; }
    if (!sym.parent) {
      const wanted = sym.exported ? 'exported' : 'internal';
      if (wanted !== section) { section = wanted; rows.push(`${wanted}:`); }
    }
    rows.push(`${sym.parent ? '    ' : '  '}${sym.startLine}-${sym.endLine}${sym.approx ? '~' : ''} ${sym.kind} ${sym.name}`);
  }
  return rows;
}

export function renderOutline(path: string, outline: OutlineResult, extra: { scannedLines?: number; complete?: boolean } = {}): string {
  const complete = extra.complete !== false;
  return [`${JSON.stringify(path)} ${outline.language}, ${extra.scannedLines ?? outline.totalLines} lines, ${outline.symbols.length} symbols (regex outline; ranges approximate, ~ = inferred end)`,
    ...(outline.symbols.length ? renderSymbols(outline.symbols) : ['(no symbols found)']),
    ...(complete ? [] : ['OUTLINE INCOMPLETE: scan budget reached before end of file.'])].join('\n');
}

/** Resolve `name`, `Parent.name` or Go `Recv.name` to candidate symbols, best first. */
export function findSymbols(symbols: OutlineSymbol[], name: string): OutlineSymbol[] {
  const wanted = name.trim();
  const dot = wanted.lastIndexOf('.');
  const matches = symbols.filter(sym => sym.name === wanted || (sym.parent && `${sym.parent}.${sym.name}` === wanted)
    || (dot > 0 && sym.name === wanted.slice(dot + 1) && sym.parent === wanted.slice(0, dot)));
  const rank = (sym: OutlineSymbol) => (sym.exported ? 0 : 2) + (sym.parent ? 1 : 0) + (sym.kind === 'impl' ? 1 : 0);
  return matches.sort((a, b) => rank(a) - rank(b) || a.startLine - b.startLine);
}
