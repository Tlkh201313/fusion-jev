import { isAbsolute } from 'node:path';
import { UsageError } from '../errors.js';
import { LIMITS } from '../limits.js';

const RUN_USAGE = 'Usage: fusion-jev run [options] -- program argv...';
const EVIDENCE_USAGE = 'Usage: fusion-jev evidence ID [--start-byte=N] [--max-bytes=N] [--raw]';
const PROVIDER_ENV = '--provider-env=';

function positiveInteger(value: string, label: string, minimum = 1): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new UsageError(`Invalid ${label}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new UsageError(`Invalid ${label}`);
  return parsed;
}

export interface RunArgs {
  raw: boolean; timeoutMs?: number; maxCaptureBytes?: number; cwd?: string; argv: [string, ...string[]];
}

/** Parses the arguments after `run`: options, a `--` separator, then the program and its argv. */
export function parseRunArgs(args: string[]): RunArgs {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) throw new UsageError(RUN_USAGE);
  const parsed: RunArgs = { raw: false, argv: args.slice(separator + 1) as [string, ...string[]] };
  for (const option of args.slice(0, separator)) {
    if (option === '--raw') parsed.raw = true;
    else if (option.startsWith('--timeout-ms=')) parsed.timeoutMs = positiveInteger(option.slice(13), 'timeout-ms');
    else if (option.startsWith('--max-capture-bytes=')) parsed.maxCaptureBytes = positiveInteger(option.slice(20), 'max-capture-bytes');
    else if (option.startsWith('--cwd=')) {
      parsed.cwd = option.slice(6);
      if (!isAbsolute(parsed.cwd)) throw new UsageError('Command cwd must be absolute');
    } else throw new UsageError(`Unknown Fusion run option: ${option}`);
  }
  if (!parsed.argv[0]) throw new UsageError(RUN_USAGE);
  return parsed;
}

export interface EvidenceArgs { id: string; raw: boolean; startByte: number; maxBytes: number }

/** Parses the arguments after `evidence`: a receipt ID and paging options. */
export function parseEvidenceArgs(args: string[]): EvidenceArgs {
  if (!args[0] || !/^[0-9a-f-]{36}$/.test(args[0])) throw new UsageError(EVIDENCE_USAGE);
  const parsed: EvidenceArgs = { id: args[0], raw: false, startByte: 0, maxBytes: LIMITS.defaultPageBytes };
  for (const option of args.slice(1)) {
    if (option === '--raw') parsed.raw = true;
    else if (option.startsWith('--start-byte=')) parsed.startByte = positiveInteger(option.slice(13), 'start-byte', 0);
    else if (option.startsWith('--max-bytes=')) parsed.maxBytes = positiveInteger(option.slice(12), 'max-bytes');
    else throw new UsageError(`Unknown Fusion evidence option: ${option}`);
  }
  if (parsed.maxBytes > LIMITS.pageBytes) throw new UsageError('max-bytes must be at most 65536');
  return parsed;
}

export interface MainArgs {
  /** Everything except --provider-env options. */
  args: string[];
  /** The --provider-env=PATH value, when given. */
  providerEnv?: string;
}

/** Separates the --provider-env option from the command words. */
export function splitProviderEnv(argv: string[]): MainArgs {
  const given = argv.filter(arg => arg.startsWith(PROVIDER_ENV));
  if (given.length > 1) throw new UsageError('Specify --env-file only once');
  return { args: argv.filter(arg => !arg.startsWith(PROVIDER_ENV)), providerEnv: given[0]?.slice(PROVIDER_ENV.length) };
}

export function assertSetupArgs(args: string[]): void {
  if (args.slice(1).some(arg => arg !== '--dry-run') || args.filter(arg => arg === '--dry-run').length > 1)
    throw new UsageError('Usage: fusion-jev setup [--dry-run] [--provider-env=ABSOLUTE_PATH]');
}

export function assertEnvFileArgs(args: string[], providerEnv: string | undefined): void {
  if (args.length !== 3 || providerEnv !== undefined) throw new UsageError('Usage: fusion-jev config env-file <ABSOLUTE_PATH | --clear>');
}
