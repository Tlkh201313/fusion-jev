import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a temp directory that is removed (recursively, best effort) when the test finishes. */
export async function makeTempDir(t: TestContext, prefix = 'fusion-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Synchronous variant of makeTempDir for synchronous fixtures. */
export function makeTempDirSync(t: TestContext, prefix = 'fusion-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run fn with a fresh temp directory and always remove it afterwards. Works for sync and async callbacks. */
export function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T>;
export function withTempDir<T>(prefix: string, fn: (dir: string) => T): T;
export function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): T | Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result: T | Promise<T>;
  try { result = fn(dir); } catch (error) { cleanup(); throw error; }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}
