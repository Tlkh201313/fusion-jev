/** Shared workspace primitives: error type, abort checks, the exclusion list and path containment. No filesystem access. */
import { relative, sep } from 'node:path';

export type WorkspaceErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'NOT_TEXT_FILE'
  | 'FILE_TOO_LARGE'
  | 'GIT_FAILED'
  | 'CANCELLED'
  | 'TIMEOUT';
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export const EXCLUDED = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.codex',
  '.npmrc',
  '.superpowers',
]);

export function excludedName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXCLUDED.has(lower) || lower === '.env' || lower.startsWith('.env.');
}

/** True when any segment of a root-relative path names an excluded file or directory. */
export function hasExcludedSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(excludedName);
}

/** Lexical containment: `path` is the root itself or lies beneath it. Both must already be absolute and normalized. */
export function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** Root-relative, forward-slash path as shown to callers; `.` for the root itself. */
export function workspaceOutputPath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/') || '.';
}

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

export function abortError(signal: AbortSignal): WorkspaceError {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? new WorkspaceError('TIMEOUT', 'Workspace action timed out')
    : new WorkspaceError('CANCELLED', 'Workspace action cancelled');
}
