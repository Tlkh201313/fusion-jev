/**
 * Fixed, read-only Git access for the workspace: executable discovery, repository pinning, scope validation,
 * the tracked/untracked file inventory and the status/diff/log commands.
 *
 * Sync fs calls here are deliberate: they are small bounded stats on repository metadata that must be checked and used
 * without an await gap (no TOCTOU window between verifying a path and handing it to Git), and they run before spawn.
 */
import { constants, accessSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  EXCLUDED,
  WorkspaceError,
  abortError,
  checkSignal,
  hasExcludedSegment,
  isWithin,
  workspaceOutputPath,
} from './workspace-base.js';

const MAX_GIT_BYTES = 32 * 1024;

export type GitCommandName = 'status' | 'diff' | 'log';
export interface GitCommandOptions {
  staged?: boolean;
  path?: string;
}
export type GitCommandResult = { command: string; argv: string[]; text: string; truncated: boolean };

// Keep the caller's scope literal while applying the same exclusions as file
// traversal. A global --literal-pathspecs flag would disable exclusion magic.
function gitPathspecs(scope: string): string[] {
  return [
    `:(literal)${scope}`,
    ...[...EXCLUDED, '.env', '.env.*'].flatMap((name) => [
      `:(exclude,icase,glob)**/${name}`,
      `:(exclude,icase,glob)**/${name}/**`,
    ]),
  ];
}

// Inspect names only: config lookup executes no filters and never captures their
// command values. Includes retain their source scope, so even a global include
// may load repository-controlled definitions. Disable every effective driver;
// repository attributes can also select an otherwise inherited global driver.
// This protects stable configuration, not concurrent introduction of new names
// between this lookup and the inspection command.
async function gitFilterOverrides(
  executable: string,
  repositoryArgs: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  const fail = () => new WorkspaceError('GIT_FAILED', 'Git configuration cannot be safely inspected');
  checkSignal(signal);
  const listed = await new Promise<{ status: number; stdout: Buffer }>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        ...repositoryArgs,
        '--no-pager',
        'config',
        '--includes',
        '--show-scope',
        '--null',
        '--name-only',
        '--get-regexp',
        '^filter\\.',
      ],
      {
        cwd,
        windowsHide: true,
        // GIT_CONFIG redirects only `git config`, not status/diff. Inspect exactly
        // the sources those commands use; retain their global/system/command env.
        env: { ...process.env, GIT_CONFIG: undefined, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stoppedError: WorkspaceError | undefined;
    const finish = (error?: WorkspaceError, status?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(abortError(signal));
      else if (error || (status !== 0 && status !== 1)) reject(error ?? fail());
      else resolve({ status, stdout: Buffer.concat(chunks) });
    };
    const stop = (error: WorkspaceError) => {
      if (settled || stoppedError) return;
      stoppedError = error;
      clearTimeout(timeout);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      // Await close before settling so the process releases its repository cwd
      // and pipe handles; cancellation still leaves the event loop responsive.
    };
    const abort = () => stop(abortError(signal));
    const timeout = setTimeout(() => stop(fail()), 5000);
    timeout.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stoppedError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_BYTES) stop(fail());
      else chunks.push(chunk);
    });
    // Discard diagnostics without allowing an unbounded stderr pipe.
    child.stderr.on('data', (chunk: Buffer) => {
      if (stoppedError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_BYTES) stop(fail());
    });
    child.once('error', () => stop(fail()));
    child.once('close', (status) => finish(stoppedError, status));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }).catch((error: unknown) => {
    if (error instanceof WorkspaceError) throw error;
    throw fail();
  });
  if (!isUtf8(listed.stdout)) throw fail();
  if (listed.status === 1) {
    if (listed.stdout.length) throw fail();
    return [];
  }
  const fields = listed.stdout.toString('utf8').split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw fail();
  const names = new Set<string>();
  for (let index = 0; index < fields.length; index += 2) {
    if (!['system', 'global', 'local', 'worktree', 'command'].includes(fields[index]!)) throw fail();
    const match = /^filter\.(.*)\.(clean|smudge|process|required)$/s.exec(fields[index + 1]!);
    if (!match) continue;
    const name = match[1]!;
    // Git permits '=' in subsection names, but -c splits its key at the first
    // '='. Refuse inspection rather than silently overriding a different key.
    if (name.includes('=')) throw fail();
    names.add(name);
  }
  return [...names].flatMap((name) => [
    ...['clean', 'smudge', 'process'].flatMap((key) => ['-c', `filter.${name}.${key}=`]),
    '-c',
    `filter.${name}.required=false`,
  ]);
}

function gitExecutable(root: string): string {
  const normalize = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
  const approvedRoot = normalize(root);
  const inWorkspace = (path: string) =>
    normalize(path) === approvedRoot || normalize(path).startsWith(approvedRoot + sep);
  // Resolve fixed inspection commands ourselves: Windows otherwise searches the
  // workspace before PATH, and either platform can honor relative PATH entries.
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    try {
      const directory = realpathSync.native(entry);
      if (inWorkspace(directory)) continue;
      const executable = realpathSync.native(join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
      if (inWorkspace(executable) || !statSync(executable).isFile()) continue;
      if (process.platform !== 'win32') accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      /* Ignore unavailable PATH candidates without running them. */
    }
  }
  throw new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace');
}

function gitRepositoryArgs(root: string): string[] {
  if (realpathSync.native(root) !== root)
    throw new WorkspaceError('INVALID_PATH', 'Workspace root changed during access');
  // Locate the physical worktree marker, including linked-worktree .git files.
  // Pin both Git boundaries so core.worktree and inherited Git environment cannot
  // redirect reads. Keep the outer worktree for a workspace bound to a subfolder;
  // Git then retains that folder's path prefix against the existing index.
  for (let directory = root; ; directory = dirname(directory)) {
    const marker = join(directory, '.git');
    if (existsSync(marker)) {
      try {
        const info = lstatSync(marker);
        if (info.isSymbolicLink()) throw new Error('redirected marker');
        if (info.isDirectory()) {
          if (realpathSync.native(marker) !== marker) throw new Error('redirected metadata');
        } else {
          const readPointer = (path: string) => {
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
              throw new Error('invalid metadata pointer');
            return readFileSync(path, 'utf8').trim();
          };
          const pointer = /^gitdir: (.+)$/.exec(readPointer(marker))?.[1];
          if (!pointer) throw new Error('invalid Git marker');
          const metadata = realpathSync.native(resolve(directory, pointer));
          if (!metadata.startsWith(directory + sep)) {
            // A legitimate linked worktree identifies this exact marker from its
            // admin directory, which is a child of the common repo's worktrees.
            const backlink = realpathSync.native(resolve(metadata, readPointer(join(metadata, 'gitdir'))));
            const common = realpathSync.native(resolve(metadata, readPointer(join(metadata, 'commondir'))));
            if (backlink !== marker || dirname(metadata) !== realpathSync.native(join(common, 'worktrees')))
              throw new Error('unrelated Git metadata');
          }
        }
        return [`--git-dir=${marker}`, `--work-tree=${directory}`];
      } catch {
        throw new WorkspaceError('GIT_FAILED', 'Git metadata is outside the approved repository or unsupported');
      }
    }
    if (dirname(directory) === directory)
      throw new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace');
  }
}

/** True when the workspace root or any ancestor contains a `.git` marker. */
export function hasGitRepository(root: string): boolean {
  for (let directory = root; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return true;
    if (dirname(directory) === directory) return false;
  }
}

/** Git history can refer to deleted paths; validate their nearest surviving parent. */
export async function resolveGitScope(root: string, input: string): Promise<string> {
  if (!input || isAbsolute(input) || input.includes('\0') || hasExcludedSegment(input))
    throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
  const target = resolve(root, input);
  if (!isWithin(root, target)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
  for (let ancestor = target; ; ancestor = dirname(ancestor)) {
    try {
      const actual = await realpath(ancestor);
      if (!isWithin(root, actual) || hasExcludedSegment(relative(root, actual)))
        throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
      return workspaceOutputPath(root, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * File inventory from Git (honors nested ignore rules without interpreting untrusted patterns ourselves).
 * Re-run before reuse so untracked additions are fresh. Null means "use the built-in exclusions instead".
 */
export async function gitSearchInventory(
  root: string,
  signal: AbortSignal,
  trackedOnly = false,
  scope = '.',
): Promise<string[] | null> {
  if (!trackedOnly && !existsSync(join(root, '.git'))) return null;
  checkSignal(signal);
  let executable: string;
  try {
    executable = gitExecutable(root);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      [
        ...gitRepositoryArgs(root),
        '-c',
        'core.fsmonitor=false',
        '--no-pager',
        'ls-files',
        '--cached',
        ...(trackedOnly ? [] : ['--others', '--exclude-standard']),
        '-z',
        '--',
        ...gitPathspecs(scope),
      ],
      {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0,
      stopped = false,
      settled = false;
    const timeout = setTimeout(() => {
      stopped = true;
      child.kill();
    }, 3000);
    const cancel = () => {
      stopped = true;
      child.kill();
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      if (code !== 0 || stopped) return resolve(null);
      const paths = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
      if (paths.length > 10_000 || paths.some((path) => isAbsolute(path) || path.split(/[\\/]/).includes('..')))
        return resolve(null);
      resolve([...new Set(paths)]);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        stopped = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.once('error', () => finish(null));
    child.once('close', finish);
  });
}

/** Run a fixed Git inspection command. Returns the rendered result and the exact captured stdout bytes. */
export async function runGitCommand(
  root: string,
  command: GitCommandName,
  signal: AbortSignal,
  options: GitCommandOptions = {},
): Promise<{ result: GitCommandResult; bytes: Buffer }> {
  checkSignal(signal);
  if (command === 'diff' && !options.staged) {
    const tracked = await gitSearchInventory(root, signal, true, options.path ?? '.');
    if (!tracked)
      throw new WorkspaceError('GIT_FAILED', 'Git scope cannot be safely inspected within the inventory limit');
    const checked = new Set<string>();
    for (const path of tracked) {
      for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
        checkSignal(signal);
        if (checked.has(parent)) break;
        checked.add(parent);
        try {
          if (lstatSync(join(root, parent)).isSymbolicLink())
            throw new WorkspaceError('GIT_FAILED', 'Git scope contains an unsupported directory alias');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }
  const operation =
    command === 'status'
      ? ['status', '--short', '--untracked-files=normal', '--ignore-submodules=dirty']
      : command === 'diff'
        ? [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--submodule=short',
            '--ignore-submodules=dirty',
            ...(options.staged ? ['--cached'] : []),
          ]
        : ['log', '-5', '--oneline', '--no-show-signature'];
  const executable = gitExecutable(root);
  const repositoryArgs = gitRepositoryArgs(root);
  const filterOverrides = command === 'log' ? [] : await gitFilterOverrides(executable, repositoryArgs, root, signal);
  checkSignal(signal);
  const args = [
    ...gitRepositoryArgs(root),
    '-c',
    'core.fsmonitor=false',
    '-c',
    'status.submoduleSummary=false',
    ...filterOverrides,
    '--no-pager',
    ...operation,
    '--',
    ...gitPathspecs(options.path ?? '.'),
  ];
  let output: { text: string; truncated: boolean; bytes: Buffer };
  try {
    output = await new Promise<{ text: string; truncated: boolean; bytes: Buffer }>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 10000);
      timeout.unref();
      const abort = () => child.kill();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const finish = (error?: WorkspaceError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(abortError(signal));
        else if (error || timedOut) reject(error ?? new WorkspaceError('TIMEOUT', 'Git command timed out'));
        else {
          const bytes = Buffer.concat(chunks);
          resolve({ text: bytes.toString('utf8'), truncated, bytes });
        }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = MAX_GIT_BYTES - bytes;
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          bytes += Math.min(room, chunk.length);
        }
        if (chunk.length > room) {
          truncated = true;
          clearTimeout(timeout);
          child.kill();
        }
      });
      child.stderr.resume();
      child.once('error', () => finish(new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace')));
      child.once('close', (code) =>
        finish(
          code === 0 || truncated
            ? undefined
            : new WorkspaceError('GIT_FAILED', 'Git command unavailable in this workspace'),
        ),
      );
    });
  } catch (error) {
    if (command === 'log' && error instanceof WorkspaceError && error.code === 'GIT_FAILED') {
      // A repository with no commits has no log; an otherwise healthy status distinguishes that from a broken Git.
      await runGitCommand(root, 'status', signal);
      return {
        result: { command: 'git log', argv: [executable, ...args], text: '', truncated: false },
        bytes: Buffer.alloc(0),
      };
    }
    throw error;
  }
  return {
    result: {
      command: `git ${command}${options.staged ? ' --cached' : ''}`,
      argv: [executable, ...args],
      text: output.text,
      truncated: output.truncated,
    },
    bytes: output.bytes,
  };
}
