/**
 * Verified file access for the workspace: every read opens the file, re-checks the canonical target and root, and fails
 * if the file changed meanwhile. Also holds the byte budgets shared by search and grep.
 */
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { WorkspaceError, checkSignal, hasExcludedSegment, isWithin } from './workspace-base.js';

export const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SEARCH_FILE_BYTES = 256 * 1024;
export const MAX_SEARCH_FILES = 1000;
export const LARGE_FILE_SCAN_BYTES = 1024 * 1024;
export const TOTAL_LARGE_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_SCAN_BYTES = 64 * 1024 * 1024;

export function decodeText(buffer: Buffer, truncated: boolean): string {
  if (buffer.includes(0)) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not UTF-8 text');
  for (let end = buffer.length, attempts = 0; attempts < 4; end--, attempts++) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)); }
    catch { if (!truncated || attempts === 3) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text'); }
  }
  throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text');
}

export function* textLines(content: string): Generator<string> {
  let start = 0;
  for (const match of content.matchAll(/\r\n|\n|\r/g)) {
    yield content.slice(start, match.index);
    start = match.index + match[0].length;
  }
  if (start < content.length) yield content.slice(start);
}

/** Verify the opened file's identity and canonical target before running `body`, and that it did not change meanwhile. */
async function withVerifiedFile<T>(root: string, target: string, signal: AbortSignal, body: (file: FileHandle, size: number) => Promise<T>): Promise<T> {
  checkSignal(signal);
  // root is the previously approved canonical directory, not fresh authority
  // to follow a junction installed after workspace path resolution.
  const canonicalRoot = resolve(root);
  const verifyRoot = async () => {
    if (await realpath(root) !== canonicalRoot) throw new WorkspaceError('INVALID_PATH', 'Workspace root changed during access');
  };
  await verifyRoot();
  const before = await realpath(target);
  const allowed = (path: string) => {
    if (!isWithin(canonicalRoot, path)) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
    if (hasExcludedSegment(relative(canonicalRoot, path))) throw new WorkspaceError('INVALID_PATH', 'Invalid workspace path');
  };
  allowed(before);
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await verifyRoot();
    const after = await realpath(target);
    allowed(after);
    const opened = await file.stat();
    let current = await stat(after);
    // Node 22.12 on Windows reports dev 0 for path-based stat but the volume serial for a handle; re-open the path so
    // both sides come from handles instead of skipping the device comparison.
    if (process.platform === 'win32' && opened.dev !== current.dev && (opened.dev === 0 || current.dev === 0)) {
      const reopened = await open(after, constants.O_RDONLY);
      try { current = await reopened.stat(); } finally { await reopened.close(); }
    }
    if (before !== after || !opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino)
      throw new WorkspaceError('INVALID_PATH', 'Workspace path changed during access');
    const value = await body(file, opened.size);
    const final = await file.stat();
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs)
      throw new WorkspaceError('INVALID_PATH', 'Workspace file changed during access');
    checkSignal(signal);
    return value;
  } finally { await file.close(); }
}

/** Verify the opened file's identity and canonical target before reading any bytes. */
export async function safeWorkspaceBytes(root: string, target: string, signal: AbortSignal = AbortSignal.timeout(15000), maxBytes = MAX_READ_FILE_BYTES): Promise<Buffer> {
  return withVerifiedFile(root, target, signal, async (file, size) => {
    if (size > maxBytes) throw new WorkspaceError('FILE_TOO_LARGE', 'File exceeds the read limit');
    const chunks: Buffer[] = [];
    const sample = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total <= maxBytes) {
      checkSignal(signal);
      const { bytesRead } = await file.read(sample, 0, Math.min(sample.length, maxBytes + 1 - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new WorkspaceError('FILE_TOO_LARGE', 'File exceeds the read limit');
      chunks.push(Buffer.from(sample.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  });
}

export interface LineStreamStats { size: number; bytes: number; lines: number; complete: boolean; stopped: boolean }

/**
 * Stream a verified UTF-8 file as lines without holding it in memory. `onLine` may return false to stop early.
 * Scans at most `maxBytes`; `complete` is false when that budget ended the scan before end of file.
 * Lines longer than 8 KiB are truncated (only their start is delivered).
 */
export async function streamWorkspaceLines(root: string, target: string, signal: AbortSignal,
  onLine: (text: string, number: number) => boolean | void, maxBytes = MAX_STREAM_SCAN_BYTES): Promise<LineStreamStats> {
  return withVerifiedFile(root, target, signal, async (file, size) => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.alloc(64 * 1024);
    let carry = '', pendingReturn = false, number = 0, total = 0, stopped = false, eof = false;
    const emit = (text: string) => { number++; if (onLine(text, number) === false) stopped = true; };
    try {
      while (!stopped && total < maxBytes) {
        checkSignal(signal);
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxBytes - total), null);
        if (!bytesRead) { eof = true; break; }
        total += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        if (chunk.includes(0)) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not UTF-8 text');
        let text = decoder.decode(chunk, { stream: true });
        if (pendingReturn) { pendingReturn = false; if (text.startsWith('\n')) text = text.slice(1); }
        const breaks = /\r\n|\n|\r/g;
        let start = 0;
        for (let match = breaks.exec(text); match && !stopped; match = breaks.exec(text)) {
          const line = carry + text.slice(start, match.index);
          carry = '';
          start = match.index + match[0].length;
          emit(line);
          if (match[0] === '\r' && start === text.length) pendingReturn = true;
        }
        if (!stopped) carry = (carry + text.slice(start)).slice(0, 8192);
      }
      if (!stopped && (eof || total >= size)) {
        const tail = carry + decoder.decode();
        eof = true;
        if (tail) emit(tail);
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error instanceof TypeError) throw new WorkspaceError('NOT_TEXT_FILE', 'File is not valid UTF-8 text');
      throw error;
    }
    return { size, bytes: total, lines: number, complete: eof && !stopped || (!stopped && total >= size), stopped };
  });
}
