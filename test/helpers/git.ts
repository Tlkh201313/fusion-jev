import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export type GitRunner = (args: string[], input?: string) => string;

/** Bind a git runner to cwd that asserts success and returns trimmed stdout. */
export function gitIn(cwd: string): GitRunner {
  return (args, input) => {
    const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
}

/** `git init` in dir with a local user identity and signing disabled; returns a bound runner. */
export function initGitRepo(dir: string, identity = 'Security Fixture', email = 'security@example.invalid'): GitRunner {
  const git = gitIn(dir);
  git(['init', '--quiet']);
  git(['config', 'user.name', identity]);
  git(['config', 'user.email', email]);
  git(['config', 'commit.gpgsign', 'false']);
  return git;
}

/** Stage everything and commit quietly. */
export function commitAll(git: GitRunner, message = 'fixture'): void {
  git(['add', '.']);
  git(['commit', '-qm', message]);
}
