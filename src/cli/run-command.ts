import { delimiter, isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { StorageVerification } from '../acl.js';
import { renderChannelSummary, summarizeChannel } from '../command-summary.js';
import { EvidenceStore, type EvidenceReceipt } from '../evidence.js';
import { LIMITS } from '../limits.js';
import { runCommand, type RunResult } from '../run.js';
import { parseRunArgs } from './args.js';
import { packageVersion, selfPath, type CliContext } from './context.js';
import { evidenceStorageDir } from './storage.js';

/** Combined captured bytes at or below this print verbatim with one status line. */
const VERBATIM_LIMIT = 1024;

/** Per-channel cap for output shown verbatim when no receipt can be stored. */
const DEGRADED_CHANNEL_LIMIT = 32 * 1024;

/** Reads every byte of a receipt back from the store, page by page. */
async function readReceipt(store: EvidenceStore, receipt: EvidenceReceipt): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let startByte = 0;
  while (startByte < receipt.storedBytes) {
    const page = await store.expand({ id: receipt.id, startByte, maxBytes: LIMITS.pageBytes });
    if (page.status !== 'ok' && page.status !== 'stale') throw new Error(`Evidence ${page.status}`);
    chunks.push(Buffer.from(page.dataBase64, 'base64'));
    if (page.nextByte === null) break;
    startByte = page.nextByte;
  }
  return Buffer.concat(chunks);
}

function utf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const emptyChannel = (receipt: EvidenceReceipt) =>
  receipt.storedBytes === 0 && receipt.originalBytes === 0 && !receipt.truncated && !receipt.redacted;

function channelFields(name: 'stdout' | 'stderr', receipt: EvidenceReceipt): string {
  if (emptyChannel(receipt)) return '';
  return (
    ` ${name}=${receipt.id} ${name}StoredBytes=${receipt.storedBytes}` +
    (receipt.originalBytes === receipt.storedBytes ? '' : ` ${name}OriginalBytes=${receipt.originalBytes ?? 'null'}`) +
    (receipt.truncated ? ` ${name}Truncated=true` : '') +
    (receipt.redacted ? ` ${name}Redacted=true` : '')
  );
}

function recoverCommand(context: CliContext): { command?: string } {
  // Name the copy that wrote the receipt: the pinned npx form when running from the npx cache,
  // the installed bin when one is on PATH, else the exact argv of this CLI.
  if (selfPath(context).split(/[\\/]/).includes('_npx'))
    return { command: `npx -y fusion-jev@${packageVersion(context)} evidence` };
  const names = process.platform === 'win32' ? ['fusion-jev.cmd', 'fusion-jev.exe', 'fusion-jev'] : ['fusion-jev'];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (dir && isAbsolute(dir) && names.some((name) => existsSync(join(dir, name))))
      return { command: 'fusion-jev evidence' };
  }
  return {};
}

/** The command already ran: show what it printed (bounded) and say plainly why nothing was stored. */
function writeWithoutReceipt(result: RunResult, stdoutBytes: Buffer, stderrBytes: Buffer, error: unknown): void {
  const reason = (error instanceof Error ? error.message : 'unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
    .replaceAll('"', "'");
  const clipped = (bytes: Buffer) => bytes.length > DEGRADED_CHANNEL_LIMIT;
  if (stderrBytes.length) process.stderr.write(stderrBytes.subarray(0, DEGRADED_CHANNEL_LIMIT));
  if (stdoutBytes.length) process.stdout.write(stdoutBytes.subarray(0, DEGRADED_CHANNEL_LIMIT));
  const lost = result.stdout.truncated || result.stderr.truncated || result.stdout.redacted || result.stderr.redacted;
  process.stdout.write(
    `${stdoutBytes.length && stdoutBytes[stdoutBytes.length - 1] !== 10 ? '\n' : ''}termination=${result.termination} exitCode=${result.exitCode ?? 'null'}` +
      (result.signal ? ` signal=${result.signal}` : '') +
      (result.errorCode ? ` errorCode=${result.errorCode}` : '') +
      ` durationMs=${Math.round(result.durationMs)} noReceipt="${reason}; output above is verbatim` +
      (clipped(stdoutBytes) || clipped(stderrBytes) ? `, limited to ${DEGRADED_CHANNEL_LIMIT} bytes per channel` : '') +
      (lost ? ', captured output was already truncated or redacted' : '') +
      '"\n',
  );
}

async function writeCompact(
  result: RunResult,
  memory: EvidenceStore,
  verification: StorageVerification,
  context: CliContext,
): Promise<void> {
  const [stdoutBytes, stderrBytes] = [
    await readReceipt(memory, result.stdout),
    await readReceipt(memory, result.stderr),
  ];
  const complete = (receipt: EvidenceReceipt) =>
    !receipt.truncated && !receipt.redacted && receipt.originalBytes === receipt.storedBytes;
  if (
    result.termination === 'exit' &&
    !result.cleanupFailed &&
    complete(result.stdout) &&
    complete(result.stderr) &&
    stdoutBytes.length + stderrBytes.length <= VERBATIM_LIMIT &&
    utf8(stdoutBytes) &&
    utf8(stderrBytes)
  ) {
    // Everything was captured and is shown in full: nothing needs a receipt or recovery.
    if (stderrBytes.length) process.stderr.write(stderrBytes);
    const separator = stdoutBytes.length && stdoutBytes[stdoutBytes.length - 1] !== 10 ? '\n' : '';
    process.stdout.write(
      Buffer.concat([
        stdoutBytes,
        Buffer.from(`${separator}exitCode=${result.exitCode} durationMs=${Math.round(result.durationMs)}\n`),
      ]),
    );
    return;
  }
  // Persist only channels with content into the verified-private store; empty channels need no receipt.
  let store: EvidenceStore | undefined;
  let stdout = result.stdout,
    stderr = result.stderr;
  try {
    // The ACL verification started before the command ran; this waits only for whatever is left of it.
    const opened = new EvidenceStore({ verifiedStorage: await verification.ready() });
    const persist = (receipt: EvidenceReceipt, bytes: Buffer): EvidenceReceipt =>
      emptyChannel(receipt)
        ? receipt
        : opened.capture({
            source: receipt.source,
            bytes,
            originalBytes: receipt.originalBytes,
            truncated: receipt.truncated,
            redacted: receipt.redacted,
          });
    stdout = persist(result.stdout, stdoutBytes);
    stderr = persist(result.stderr, stderrBytes);
    store = opened;
  } catch (error) {
    // Never lose the command's result because storage could not be verified or written.
    writeWithoutReceipt(result, stdoutBytes, stderrBytes, error);
    return;
  }
  process.stdout.write(
    `termination=${result.termination} exitCode=${result.exitCode ?? 'null'}` +
      (result.signal ? ` signal=${result.signal}` : '') +
      (result.errorCode ? ` errorCode=${result.errorCode}` : '') +
      ` durationMs=${Math.round(result.durationMs)}${channelFields('stdout', stdout)}${channelFields('stderr', stderr)}` +
      (result.cleanupFailed ? ' cleanupFailed=true' : '') +
      '\n',
  );
  const summaries = {
    stdout: store && !emptyChannel(stdout) ? await summarizeChannel(store, stdout) : undefined,
    stderr: store && !emptyChannel(stderr) ? await summarizeChannel(store, stderr) : undefined,
  };
  if (summaries.stdout) process.stdout.write(renderChannelSummary(summaries.stdout));
  if (summaries.stderr) process.stderr.write(renderChannelSummary(summaries.stderr));
  // One recovery line per channel whose bytes were not shown in full.
  const recover = recoverCommand(context);
  for (const [name, receipt, summary] of [
    ['Stdout', stdout, summaries.stdout],
    ['Stderr', stderr, summaries.stderr],
  ] as const) {
    if (!summary || (summary.omittedBytes === 0 && !summary.unavailable)) continue;
    process.stdout.write(
      recover.command
        ? `recover${name}=${recover.command} ${receipt.id} --raw\n`
        : `recover${name}Argv=${JSON.stringify([process.execPath, selfPath(context), 'evidence', receipt.id, '--raw'])}\n`,
    );
  }
}

function exitCodeFor(result: RunResult): number {
  return result.termination === 'exit'
    ? (result.exitCode ?? 1)
    : result.termination === 'timeout'
      ? 124
      : result.termination === 'cancelled'
        ? 130
        : result.termination === 'spawn_error'
          ? 127
          : 128;
}

/** `fusion-jev run [options] -- program argv...` */
export async function runCli(args: string[], context: CliContext): Promise<void> {
  const { raw, timeoutMs, maxCaptureBytes, cwd, argv } = parseRunArgs(args);
  // Raw output already reaches the host byte-for-byte and publishes no receipts.
  // Compact runs capture in memory first: output that is small enough to show in full
  // needs no receipt. The private store's Windows ACL verification starts now, in parallel
  // with the command, and is awaited only if a receipt turns out to be needed (otherwise it
  // is abandoned). Every disk write still happens after that verification completes.
  const storageDir = raw ? undefined : evidenceStorageDir();
  const memory = new EvidenceStore();
  let verification: StorageVerification | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const running = runCommand({ argv, cwd, timeoutMs, maxCaptureBytes, raw }, memory, controller.signal);
    // runCommand has launched the child synchronously; only now start the verification so it never delays the launch.
    if (storageDir) verification = new StorageVerification(storageDir);
    const result = await running;
    if (verification) await writeCompact(result, memory, verification, context);
    process.exitCode = exitCodeFor(result);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await verification?.discard();
  }
}
