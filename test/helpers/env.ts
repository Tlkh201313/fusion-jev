import type { TestContext } from 'node:test';
import { delimiter } from 'node:path';

/** The actual key holding PATH in process.env (Windows may spell it `Path`). */
export function pathKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
}

/** Return a copy of env with dirs prepended to PATH (first entry wins). */
export function envWithPathFirst(env: NodeJS.ProcessEnv, ...dirs: string[]): NodeJS.ProcessEnv {
  const key = pathKey(env);
  return { ...env, [key]: [...dirs, env[key] ?? ''].join(delimiter) };
}

/**
 * Set (or delete, when the value is undefined) process.env variables and return a restore function.
 * Restore is idempotent and also runs from t.after when a TestContext is provided.
 */
export function setEnv(vars: Record<string, string | undefined>, t?: TestContext): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  };
  t?.after(restore);
  return restore;
}

/** Run fn with env vars applied; always restores them, even when fn throws or rejects. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const restore = setEnv(vars);
  try { return await fn(); } finally { restore(); }
}

/** Prepend dirs to process.env PATH (honouring its real key) with guaranteed restore. */
export function setPathFirst(dirs: string[], t?: TestContext): () => void {
  const key = pathKey();
  return setEnv({ [key]: [...dirs, process.env[key] ?? ''].join(delimiter) }, t);
}
