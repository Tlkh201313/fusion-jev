import { basename } from 'node:path';
import { clip } from './util/text.js';

/**
 * Deterministic, conservative summaries for informational git output (log, show, diff, status, branch).
 * Detection is by argv: any flag outside a per-subcommand allowlist, or any output that does not parse
 * cleanly, returns undefined so the caller falls back to the generic path. Nothing is dropped silently:
 * every summary says what was omitted, and the caller prints the receipt recovery line.
 */
const GIT_LIST_BUDGET_BYTES = 2400; // about 600 tokens at 4 bytes per token
const MAX_STAT_ROWS = 25;
const MAX_STATUS_PATHS = 20;
const MAX_BRANCHES = 30;
const SUBJECT_CLIP = 100;

const LOG_FLAGS =
  /^(?:-p|-u|--patch|--stat(?:=[\d,]+)?|--numstat|--shortstat|--name-only|--name-status|--oneline|--no-color|--decorate|--no-decorate|--abbrev-commit|--no-merges|--first-parent|--all|--reverse|--no-patch|-s|-\d+|-U\d+|-w|--pretty=(?:oneline|medium|short|full)|--max-count=\d+|--(?:author|since|until|after|before|grep)=.*)$/;
const DIFF_FLAGS =
  /^(?:--stat(?:=[\d,]+)?|--numstat|--shortstat|--name-only|--name-status|--cached|--staged|-p|-u|--patch|--no-color|--no-ext-diff|-U\d+|-w|-b|-M|--find-renames|--summary|--no-renames)$/;
const STATUS_FLAGS =
  /^(?:-s|-sb|--short|--porcelain(?:=v1)?|-b|--branch|-u(?:no|normal|all)?|--untracked-files(?:=(?:no|normal|all))?|--no-color|--ignored(?:=\w+)?)$/;
const BRANCH_FLAGS = /^(?:-a|--all|-r|--remotes|-v|-vv|--verbose|--list|--no-color|--no-column)$/;

interface GitCommand {
  sub: 'log' | 'show' | 'diff' | 'status' | 'branch';
  flags: string[];
  operands: string[];
}

function parseCommand(argv: readonly string[]): GitCommand | undefined {
  const program = basename(argv[0] ?? '')
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (program !== 'git') return undefined;
  let at = 1;
  while (argv[at] === '--no-pager') at++;
  const sub = argv[at++];
  if (sub !== 'log' && sub !== 'show' && sub !== 'diff' && sub !== 'status' && sub !== 'branch') return undefined;
  const allowed =
    sub === 'log' || sub === 'show'
      ? LOG_FLAGS
      : sub === 'diff'
        ? DIFF_FLAGS
        : sub === 'status'
          ? STATUS_FLAGS
          : BRANCH_FLAGS;
  const flags: string[] = [],
    operands: string[] = [];
  let pathsOnly = false;
  for (; at < argv.length; at++) {
    const arg = argv[at]!;
    if (pathsOnly) {
      operands.push(arg);
      continue;
    }
    if (arg === '--') {
      pathsOnly = true;
      continue;
    }
    if ((sub === 'log' || sub === 'show') && arg === '-n' && /^\d+$/.test(argv[at + 1] ?? '')) {
      flags.push(`-${argv[++at]}`);
      continue;
    }
    if ((sub === 'log' || sub === 'show') && /^-n\d+$/.test(arg)) {
      flags.push(`-${arg.slice(2)}`);
      continue;
    }
    if (arg.startsWith('-')) {
      if (!allowed.test(arg)) return undefined;
      flags.push(arg);
      continue;
    }
    operands.push(arg);
  }
  // `git branch <name>` creates a branch; anything with operands there is not an informational listing.
  if (sub === 'branch' && operands.length) return undefined;
  return { sub, flags, operands };
}

const byteLength = (text: string) => Buffer.byteLength(text);
const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};
function shortDate(raw: string): string | undefined {
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (iso) return iso[1];
  const match = /^\w{3} (\w{3}) (\d{1,2}) [\d:]+ (\d{4})/.exec(raw);
  return match && MONTHS[match[1]!] ? `${match[3]}-${MONTHS[match[1]!]}-${match[2]!.padStart(2, '0')}` : undefined;
}

interface PatchFile {
  path: string;
  hunks: number;
  add: number;
  del: number;
  status?: string;
}

/** Streaming unified-diff scanner. Hunk bodies are consumed by their declared line counts so content can never be mistaken for headers. */
class PatchState {
  files: PatchFile[] = [];
  bail = false;
  private current: PatchFile | undefined;
  private old = 0;
  private next = 0;
  feed(line: string): boolean {
    if (this.old > 0 || this.next > 0) {
      const head = line[0];
      if (head === ' ' || line === '') {
        this.old--;
        this.next--;
        return true;
      }
      if (head === '-') {
        this.old--;
        this.current!.del++;
        return true;
      }
      if (head === '+') {
        this.next--;
        this.current!.add++;
        return true;
      }
      if (head === '\\') return true;
      this.old = this.next = 0; // Malformed hunk: resynchronize on this line.
    }
    if (line.startsWith('diff --git ')) {
      const rest = line.slice(11);
      let path: string | undefined;
      for (let at = rest.indexOf(' b/'); at >= 0; at = rest.indexOf(' b/', at + 1)) {
        if (rest.startsWith('a/') && rest.slice(2, at) === rest.slice(at + 3)) {
          path = rest.slice(at + 3);
          break;
        }
        path = rest.slice(at + 3);
      }
      this.current = { path: path ?? rest, hunks: 0, add: 0, del: 0 };
      this.files.push(this.current);
      return true;
    }
    if (/^diff --(?:cc|combined) /.test(line) || line.startsWith('@@@')) {
      this.bail = true;
      return true;
    }
    if (!this.current) return false;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      this.current.hunks++;
      this.old = hunk[1] === undefined ? 1 : Number(hunk[1]);
      this.next = hunk[2] === undefined ? 1 : Number(hunk[2]);
      return true;
    }
    if (line.startsWith('new file mode')) {
      this.current.status = 'new';
      return true;
    }
    if (line.startsWith('deleted file mode')) {
      this.current.status = 'deleted';
      return true;
    }
    const renamed = /^rename to (.+)$/.exec(line);
    if (renamed) {
      this.current.status = 'renamed';
      this.current.path = renamed[1]!;
      return true;
    }
    if (line.startsWith('Binary files ')) {
      this.current.status = `${this.current.status ?? 'modified'} binary`;
      return true;
    }
    return /^(?:index |--- |\+\+\+ |old mode|new mode|similarity index|dissimilarity index|rename from|copy from|copy to)/.test(
      line,
    );
  }
}

const STAT_ROW = /^ (.+?)\s+\|\s+(\d+(?: [+-]+)?|Bin\b.*)$/;
const STAT_SUMMARY = /^ (\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line, index, all) => index < all.length - 1 || line !== '');

interface CommitInfo {
  sha: string;
  subject?: string;
  author?: string;
  date?: string;
  patch: PatchState;
  statFiles?: number;
  statAdd?: number;
  statDel?: number;
  numFiles: number;
  numAdd: number;
  numDel: number;
  nameFiles: number;
  sawNumstat: boolean;
}

function summarizeLog(command: GitCommand, text: string): string | undefined {
  const oneline = command.flags.some((flag) => flag === '--oneline' || flag === '--pretty=oneline');
  const nameMode = command.flags.some((flag) => flag === '--name-only' || flag === '--name-status');
  const commits: CommitInfo[] = [];
  let current: CommitInfo | undefined;
  let bodySeen = false;
  const start = (sha: string, subject?: string) => {
    current = {
      sha,
      ...(subject === undefined ? {} : { subject }),
      patch: new PatchState(),
      numFiles: 0,
      numAdd: 0,
      numDel: 0,
      nameFiles: 0,
      sawNumstat: false,
    };
    commits.push(current);
    bodySeen = subject !== undefined;
  };
  for (const line of lines(text)) {
    if (current?.patch.feed(line)) continue;
    if (oneline) {
      const match = /^([0-9a-f]{7,40})(?: \([^)]*\))? (.*)$/.exec(line);
      if (match && !(current && (line.startsWith(' ') || line.includes('\t')))) {
        start(match[1]!, match[2]!);
        continue;
      }
      if (!current) return undefined;
    } else {
      const header = /^commit ([0-9a-f]{7,64})(?: \(.*\))?$/.exec(line);
      if (header) {
        start(header[1]!);
        continue;
      }
      if (!current) return undefined;
      const author = /^Author:\s+(.*?)(?:\s+<[^>]*>)?\s*$/.exec(line);
      if (author && !bodySeen) {
        current.author = author[1]!;
        continue;
      }
      const date = /^Date:\s+(.*)$/.exec(line);
      if (date && !bodySeen) {
        current.date = shortDate(date[1]!.trim());
        continue;
      }
      if (/^(?:Merge|Commit|CommitDate|AuthorDate|Reflog[^:]*):/.test(line) && !bodySeen) continue;
      const message = /^ {4}(.*)$/.exec(line);
      if (message) {
        if (current.subject === undefined && message[1]!.trim()) {
          current.subject = message[1]!.trim();
          bodySeen = true;
        }
        continue;
      }
    }
    const row = STAT_ROW.exec(line);
    if (row) continue;
    const summary = STAT_SUMMARY.exec(line);
    if (summary) {
      current!.statFiles = Number(summary[1]);
      current!.statAdd = Number(summary[2] ?? 0);
      current!.statDel = Number(summary[3] ?? 0);
      continue;
    }
    const numstat = NUMSTAT.exec(line);
    if (numstat) {
      current!.sawNumstat = true;
      current!.numFiles++;
      if (numstat[1] !== '-') current!.numAdd += Number(numstat[1]);
      if (numstat[2] !== '-') current!.numDel += Number(numstat[2]);
      continue;
    }
    if (nameMode && line.trim() && !line.startsWith(' ')) {
      current!.nameFiles++;
      continue;
    }
    if (line.trim() === '') continue;
    return undefined; // Unrecognized content: refuse to guess.
  }
  if (!commits.length || commits.some((commit) => commit.patch.bail || commit.subject === undefined)) return undefined;
  const stats = (commit: CommitInfo): { files: number; add?: number; del?: number } | undefined => {
    if (commit.patch.files.length)
      return {
        files: commit.patch.files.length,
        add: commit.patch.files.reduce((sum, file) => sum + file.add, 0),
        del: commit.patch.files.reduce((sum, file) => sum + file.del, 0),
      };
    if (commit.statFiles !== undefined)
      return { files: commit.statFiles, add: commit.statAdd ?? 0, del: commit.statDel ?? 0 };
    if (commit.sawNumstat) return { files: commit.numFiles, add: commit.numAdd, del: commit.numDel };
    if (commit.nameFiles) return { files: commit.nameFiles };
    return undefined;
  };
  const all = commits.map(stats);
  const withStats = all.filter((value): value is NonNullable<typeof value> => value !== undefined);
  const totals = withStats.length
    ? ` | ${withStats.reduce((sum, value) => sum + value.files, 0)} files changed${
        withStats.some((value) => value.add !== undefined)
          ? ` (+${withStats.reduce((sum, value) => sum + (value.add ?? 0), 0)} -${withStats.reduce((sum, value) => sum + (value.del ?? 0), 0)})`
          : ''
      }`
    : '';
  const out = [
    `git ${command.sub}: ${commits.length} commit${commits.length === 1 ? '' : 's'}${totals} (subjects only; message bodies${withStats.length ? ' and diffs' : ''} omitted)`,
  ];
  let used = byteLength(out[0]!) + 1,
    shown = 0;
  for (const [index, commit] of commits.entries()) {
    const detail = [commit.author, commit.date].filter(Boolean).join(', ');
    const value = all[index];
    const stat = value
      ? ` [${value.files} file${value.files === 1 ? '' : 's'}${value.add === undefined ? '' : ` +${value.add} -${value.del ?? 0}`}]`
      : '';
    const row = `${commit.sha.slice(0, 7)} ${clip(commit.subject!, SUBJECT_CLIP)}${detail ? ` (${detail})` : ''}${stat}`;
    if (shown > 0 && used + byteLength(row) + 1 > GIT_LIST_BUDGET_BYTES) break;
    out.push(row);
    used += byteLength(row) + 1;
    shown++;
  }
  if (shown < commits.length) out.push(`+${commits.length - shown} more commits omitted, recover with the receipt`);
  return out.join('\n') + '\n';
}

interface StatRow {
  path: string;
  churn: number;
  add?: number;
  del?: number;
  binary?: boolean;
}

function summarizeDiff(command: GitCommand, text: string): string | undefined {
  const patch = new PatchState();
  const rows: StatRow[] = [];
  const names: string[] = [];
  let summary: RegExpExecArray | null = null;
  let sawNumstat = false;
  const nameMode = command.flags.some((flag) => flag === '--name-only' || flag === '--name-status');
  for (const line of lines(text)) {
    if (patch.feed(line)) continue;
    if (line.trim() === '') continue;
    const numstat = NUMSTAT.exec(line);
    if (numstat) {
      sawNumstat = true;
      const binary = numstat[1] === '-';
      rows.push({
        path: numstat[3]!,
        churn: binary ? 0 : Number(numstat[1]) + Number(numstat[2]),
        ...(binary ? { binary: true } : { add: Number(numstat[1]), del: Number(numstat[2]) }),
      });
      continue;
    }
    const row = STAT_ROW.exec(line);
    if (row) {
      const count = /^(\d+)(?: [+-]+)?$/.exec(row[2]!);
      rows.push({ path: row[1]!, churn: count ? Number(count[1]) : 0, ...(count ? {} : { binary: true }) });
      continue;
    }
    const total = STAT_SUMMARY.exec(line);
    if (total) {
      summary = total;
      continue;
    }
    if (nameMode) {
      names.push(line);
      continue;
    }
    return undefined;
  }
  if (patch.bail) return undefined;
  const label = `git diff${command.flags.some((flag) => flag === '--cached' || flag === '--staged') ? ' --cached' : ''}`;
  if (patch.files.length) {
    const sorted = patch.files
      .map((file, order) => ({ file, order }))
      .sort((a, b) => b.file.add + b.file.del - (a.file.add + a.file.del) || a.order - b.order);
    const add = patch.files.reduce((sum, file) => sum + file.add, 0),
      del = patch.files.reduce((sum, file) => sum + file.del, 0);
    const hunks = patch.files.reduce((sum, file) => sum + file.hunks, 0);
    const out = [
      `${label}: ${patch.files.length} file${patch.files.length === 1 ? '' : 's'}, ${hunks} hunk${hunks === 1 ? '' : 's'}, +${add} -${del} (patch bodies omitted; files sorted by churn)`,
    ];
    let used = byteLength(out[0]!) + 1,
      shown = 0;
    for (const { file } of sorted) {
      const row = `${file.path}${file.status ? ` (${file.status})` : ''}: ${file.hunks} hunk${file.hunks === 1 ? '' : 's'} +${file.add} -${file.del}`;
      if (shown > 0 && used + byteLength(row) + 1 > GIT_LIST_BUDGET_BYTES) break;
      out.push(row);
      used += byteLength(row) + 1;
      shown++;
    }
    if (shown < sorted.length) out.push(`+${sorted.length - shown} more files omitted, recover with the receipt`);
    return out.join('\n') + '\n';
  }
  if (rows.length) {
    const sorted = rows
      .map((row, order) => ({ row, order }))
      .sort((a, b) => b.row.churn - a.row.churn || a.order - b.order)
      .map((item) => item.row);
    const shownRows = sorted.slice(0, MAX_STAT_ROWS);
    const addSum = rows.reduce((sum, row) => sum + (row.add ?? 0), 0),
      delSum = rows.reduce((sum, row) => sum + (row.del ?? 0), 0);
    const totals = summary
      ? `${summary[1]} files changed${summary[2] ? `, ${summary[2]} insertions(+)` : ''}${summary[3] ? `, ${summary[3]} deletions(-)` : ''}`
      : `${rows.length} files changed${sawNumstat ? `, ${addSum} insertions(+), ${delSum} deletions(-)` : ''}`;
    const out = [`${label}: ${totals} (stat rows sorted by churn)`];
    for (const row of shownRows)
      out.push(
        row.binary
          ? `${row.path} | binary`
          : sawNumstat
            ? `${row.path} | +${row.add} -${row.del}`
            : `${row.path} | ${row.churn}`,
      );
    if (shownRows.length < sorted.length)
      out.push(`+${sorted.length - shownRows.length} more files omitted, recover with the receipt`);
    return out.join('\n') + '\n';
  }
  if (names.length) {
    const shownNames = names.slice(0, MAX_STAT_ROWS * 2);
    const out = [`${label}: ${names.length} file${names.length === 1 ? '' : 's'} changed`, ...shownNames];
    if (shownNames.length < names.length)
      out.push(`+${names.length - shownNames.length} more files omitted, recover with the receipt`);
    return out.join('\n') + '\n';
  }
  return undefined;
}

interface StatusEntry {
  group: 'staged' | 'unstaged' | 'untracked' | 'unmerged' | 'ignored';
  kind: string;
  path: string;
}
const SHORT_KIND: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'unmerged',
};

function summarizeStatus(_command: GitCommand, text: string): string | undefined {
  const entries: StatusEntry[] = [];
  const head: string[] = [];
  const all = lines(text);
  const short = _command.flags.some((flag) => /^(?:-sb?|--short|--porcelain(?:=v1)?)$/.test(flag));
  if (short) {
    for (const line of all) {
      if (line.startsWith('## ')) {
        head.push(line.slice(3));
        continue;
      }
      const match = /^([ MADRCTU?!])([ MADRCTU?!]) (.+)$/.exec(line);
      if (!match) return undefined;
      const [, x, y, path] = match as unknown as [string, string, string, string];
      if (x === '?' && y === '?') entries.push({ group: 'untracked', kind: 'untracked', path });
      else if (x === '!' && y === '!') entries.push({ group: 'ignored', kind: 'ignored', path });
      else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'))
        entries.push({ group: 'unmerged', kind: `${x}${y}`, path });
      else {
        if (x !== ' ') entries.push({ group: 'staged', kind: SHORT_KIND[x] ?? x, path });
        if (y !== ' ') entries.push({ group: 'unstaged', kind: SHORT_KIND[y] ?? y, path });
      }
    }
  } else {
    let group: StatusEntry['group'] | undefined,
      headDone = false;
    for (const line of all) {
      if (!headDone) {
        if (line.trim() === '') {
          headDone = true;
          continue;
        }
        if (
          !/^(?:On branch|HEAD detached|Your branch|Rebasing|No commits yet|Initial commit|You have unmerged|interactive rebase)/.test(
            line,
          ) &&
          !/^\s/.test(line) &&
          head.length >= 3
        )
          return undefined;
        if (head.length < 3) head.push(line);
        continue;
      }
      if (line.trim() === '') continue;
      if (line === 'Changes to be committed:') {
        group = 'staged';
        continue;
      }
      if (line === 'Changes not staged for commit:') {
        group = 'unstaged';
        continue;
      }
      if (line === 'Untracked files:') {
        group = 'untracked';
        continue;
      }
      if (line === 'Unmerged paths:') {
        group = 'unmerged';
        continue;
      }
      if (line === 'Ignored files:') {
        group = 'ignored';
        continue;
      }
      if (
        /^\s+\(use /.test(line) ||
        /^(?:no changes added|nothing to commit|nothing added|Untracked files not listed|It took )/.test(line)
      )
        continue;
      const item = /^\t(.+)$/.exec(line);
      if (!item || !group) return undefined;
      const kind = /^([a-z][a-z ]*?):\s+(.+)$/.exec(item[1]!);
      entries.push(
        kind && group !== 'untracked' && group !== 'ignored'
          ? { group, kind: kind[1]!, path: kind[2]! }
          : { group, kind: group, path: item[1]! },
      );
    }
  }
  if (!entries.length && !all.some((line) => /nothing to commit|working tree clean/.test(line))) return undefined;
  const order: StatusEntry['group'][] = ['staged', 'unstaged', 'unmerged', 'untracked', 'ignored'];
  const counts = order
    .map((group) => [group, entries.filter((entry) => entry.group === group).length] as const)
    .filter(([, count]) => count);
  const out = [
    `git status: ${head.length ? head.map((item) => clip(item, 120)).join(' | ') : 'branch line not shown'}`,
    entries.length ? counts.map(([group, count]) => `${group} ${count}`).join(', ') : 'clean (nothing to commit)',
  ];
  let shown = 0;
  for (const group of order) {
    const members = entries.filter((entry) => entry.group === group);
    if (!members.length || shown >= MAX_STATUS_PATHS) continue;
    const slice = members.slice(0, MAX_STATUS_PATHS - shown);
    out.push(`${group}:`);
    for (const entry of slice) out.push(entry.kind === group ? `  ${entry.path}` : `  ${entry.kind} ${entry.path}`);
    shown += slice.length;
  }
  if (shown < entries.length) out.push(`+${entries.length - shown} more paths omitted, recover with the receipt`);
  return out.join('\n') + '\n';
}

function summarizeBranch(command: GitCommand, text: string): string | undefined {
  const names: string[] = [];
  let current: string | undefined;
  for (const line of lines(text)) {
    const match = /^([* +]) (\(.*?\)|\S+)(?: .*)?$/.exec(line);
    if (!match) return undefined;
    names.push(match[2]!);
    if (match[1] === '*') current = match[2]!;
  }
  if (!names.length) return undefined;
  const shown = names.slice(0, MAX_BRANCHES);
  const verbose = command.flags.some((flag) => /^-v+$|^--verbose$/.test(flag));
  const out = [
    `git branch: ${names.length} branch${names.length === 1 ? '' : 'es'}${current ? `, current ${current}` : ''}${verbose ? ' (per-branch commit details omitted)' : ''}`,
    shown.join(', '),
  ];
  if (shown.length < names.length)
    out.push(`+${names.length - shown.length} more branches omitted, recover with the receipt`);
  return out.join('\n') + '\n';
}

/** Returns a compact informational summary, or undefined when argv/output is not an exactly recognized git listing. */
export function summarizeGit(argv: readonly string[], text: string): string | undefined {
  const command = parseCommand(argv);
  if (!command) return undefined;
  try {
    if (command.sub === 'log' || command.sub === 'show') return summarizeLog(command, text);
    if (command.sub === 'diff') return summarizeDiff(command, text);
    if (command.sub === 'status') return summarizeStatus(command, text);
    return summarizeBranch(command, text);
  } catch {
    return undefined;
  }
}
