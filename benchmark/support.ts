import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { parseDiagnostics } from '../src/diagnostics.js';
import { renderChannelSummary, summarizeChannel } from '../src/command-summary.js';
import { EvidenceStore } from '../src/evidence.js';
import { createFusionMcpServer, type RoutingService } from '../src/mcp.js';
import { runCommand } from '../src/run.js';
import { WorkspaceService } from '../src/workspace.js';
import { noisyFixtures, supportFixtures, type SupportFixture } from './support-fixtures.js';

type Strategy = 'native' | 'rtk' | 'fusion';
interface Channels {
  stdout: Buffer;
  stderr: Buffer;
}
interface Sample extends Channels {
  visible: unknown;
  exitCode: number;
  durationMs: number;
  cacheStartupMs: number | null;
  executedArgv: string[];
  expansionBytes?: number;
  available?: boolean;
  unavailableReason?: string;
}
export function assessRecovery(
  actual: Channels,
  expected: Channels,
): { exactRecovery: boolean; omission: boolean; silentLoss: boolean } {
  const exactRecovery = actual.stdout.equals(expected.stdout) && actual.stderr.equals(expected.stderr);
  return { exactRecovery, omission: !exactRecovery, silentLoss: !exactRecovery };
}
export interface SupportObservation {
  fixtureId: string;
  strategy: Strategy;
  hostVisibleBytes: number;
  tokenEstimate: number;
  exactRecovery: boolean;
  omission: boolean;
  wrongPassFail: boolean;
  diagnosticTruthMatched: boolean;
  unauthorizedExecution: boolean;
  silentLoss: boolean;
  qualityMet: boolean;
  providerCalls: number;
  providerTokens: number | null;
  cacheHits: number;
  escalations: number;
  p50Ms: number;
  p95Ms: number;
  costUsd: number | null;
  expansionBytes: number;
  available: boolean;
  unavailableReason?: string;
}
export interface SupportReport {
  mode: 'offline';
  fixtures: Array<
    Pick<
      SupportFixture,
      | 'id'
      | 'task'
      | 'expectedStdout'
      | 'expectedStderr'
      | 'expectedExit'
      | 'diagnosticTruth'
      | 'approvedArgv'
      | 'qualityRubric'
    >
  >;
  strategies: Strategy[];
  method: { bytes: string; tokenEstimate: string; latency: string };
  observations: SupportObservation[];
  windowsPrivateCacheStartupMs: number | null;
  gates: { hostTokenReduction: 'unverified'; cost: 'unverified'; latency: 'unverified'; quality: 'unverified' };
  superiorityClaim: null;
}

const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const percentile = (values: number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))]!.toFixed(2));
};

function runLocal(fixture: SupportFixture, strategy: 'native' | 'rtk', root: string, rtkExecutable = 'rtk'): Sample {
  const nodeArgv = fixture.approvedArgv;
  const argv =
    strategy === 'native'
      ? nodeArgv
      : [
          rtkExecutable,
          fixture.kind === 'file' ? 'read' : 'err',
          ...(fixture.kind === 'file' ? [fixture.path!] : fixture.approvedArgv),
        ];
  const start = performance.now();
  const child = spawnSync(argv[0]!, argv.slice(1), {
    cwd: root,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = performance.now() - start;
  if (child.error) {
    if (strategy !== 'rtk' || (child.error as NodeJS.ErrnoException).code !== 'ENOENT') throw child.error;
    return {
      available: false,
      unavailableReason: 'executable-not-found',
      visible: { unavailable: 'RTK executable not found' },
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: -1,
      durationMs,
      cacheStartupMs: null,
      executedArgv: [],
    };
  }
  const stdout = child.stdout ?? Buffer.alloc(0);
  const stderr = child.stderr ?? Buffer.alloc(0);
  return {
    visible: { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: child.status },
    stdout,
    stderr,
    exitCode: child.status ?? -1,
    durationMs,
    cacheStartupMs: null,
    executedArgv: argv,
  };
}

async function runFusionFile(fixture: SupportFixture, client: Client): Promise<Sample> {
  const start = performance.now();
  const inspection = await client.callTool({
    name: 'fusion_inspect',
    arguments: { requests: [{ action: 'read', path: fixture.path }] },
  });
  const refs =
    (inspection.structuredContent as { evidenceRefs?: Array<{ receipt?: { id: string } }> })?.evidenceRefs ?? [];
  const id = refs[0]?.receipt?.id;
  assert.ok(id, 'Fusion inspection did not supply an evidence receipt');
  const page = await client.callTool({ name: 'fusion_evidence', arguments: { action: 'get', id } });
  const data = page.structuredContent as { status: string; dataBase64?: string; nextByte?: number | null };
  assert.equal(data.status, 'ok');
  assert.equal(data.nextByte, null, 'Fixture exceeds one exact evidence page');
  const recovered = Buffer.from(data.dataBase64!, 'base64');
  return {
    visible: inspection,
    expansionBytes: recovered.length,
    stdout: recovered,
    stderr: Buffer.alloc(0),
    exitCode: 0,
    durationMs: performance.now() - start,
    cacheStartupMs: null,
    executedArgv: [],
  };
}

async function runFusionCommand(fixture: SupportFixture, root: string, cacheRoot: string): Promise<Sample> {
  const start = performance.now();
  const store = new EvidenceStore({ storageDir: cacheRoot });
  const cacheStartupMs = performance.now() - start;
  const result = await runCommand({ argv: fixture.approvedArgv as [string, ...string[]], cwd: root }, store);
  const recover = async (id: string) => {
    const chunks: Buffer[] = [];
    let startByte = 0;
    do {
      const page = await store.expand({ id, startByte, maxBytes: 64 * 1024 });
      if (page.status !== 'ok') throw new Error('Command evidence unavailable');
      chunks.push(Buffer.from(page.dataBase64, 'base64'));
      if (page.nextByte === null) break;
      startByte = page.nextByte;
    } while (true);
    return Buffer.concat(chunks);
  };
  const stdout = await recover(result.stdout.id),
    stderr = await recover(result.stderr.id);
  const outSummary = renderChannelSummary(await summarizeChannel(store, result.stdout));
  const errSummary = renderChannelSummary(await summarizeChannel(store, result.stderr));
  return {
    visible: {
      termination: result.termination,
      exitCode: result.exitCode,
      stdoutId: result.stdout.id,
      stderrId: result.stderr.id,
      stdoutTruncated: result.stdout.truncated,
      stderrTruncated: result.stderr.truncated,
      stdout: outSummary,
      stderr: errSummary,
    },
    expansionBytes: stdout.length + stderr.length,
    stdout,
    stderr,
    exitCode: result.exitCode ?? -1,
    durationMs: performance.now() - start,
    cacheStartupMs,
    executedArgv: fixture.approvedArgv,
  };
}

export async function runSupportBenchmark(
  options: { rounds?: number; corpus?: 'smoke' | 'noisy' | '120'; rtkExecutable?: string } = {},
): Promise<SupportReport> {
  const rounds = options.rounds ?? 3;
  const fixtures =
    options.corpus === '120' ? noisyFixtures(20) : options.corpus === 'noisy' ? noisyFixtures() : supportFixtures;
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) throw new RangeError('Invalid benchmark rounds');
  const root = await mkdtemp(join(tmpdir(), 'fusion-support-workspace-'));
  const cacheParent = process.platform === 'win32' ? process.env.LOCALAPPDATA : tmpdir();
  if (!cacheParent) throw new Error('Private Windows cache location unavailable');
  const cacheRoot = await mkdtemp(join(cacheParent, 'fusion-support-cache-'));
  let providerCalls = 0;
  const router: RoutingService = {
    async route() {
      providerCalls++;
      throw new Error('Offline benchmark must not call Jev');
    },
    async routeBatch() {
      providerCalls++;
      throw new Error('Offline benchmark must not call Jev');
    },
  };
  const evidence = new EvidenceStore();
  const server = createFusionMcpServer({
    router,
    config: loadConfig({ FUSION_MCP_PROFILE: 'assist' }),
    workspace: new WorkspaceService(root, router),
    evidence,
  });
  const client = new Client({ name: 'support-benchmark', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    for (const fixture of fixtures)
      if (fixture.kind === 'file') await writeFile(join(root, fixture.path!), fixture.content!);
    await server.connect(left);
    await client.connect(right);
    const samples = new Map<string, Sample[]>();
    const strategies: Strategy[] = ['native', 'rtk', 'fusion'];
    for (let round = 0; round < rounds; round++) {
      for (const [index, fixture] of fixtures.entries()) {
        for (let turn = 0; turn < strategies.length; turn++) {
          const strategy = strategies[(round + index + turn) % strategies.length]!;
          const sample =
            strategy === 'fusion'
              ? fixture.kind === 'file'
                ? await runFusionFile(fixture, client)
                : await runFusionCommand(fixture, root, cacheRoot)
              : runLocal(fixture, strategy, root, options.rtkExecutable);
          const key = `${fixture.id}:${strategy}`;
          samples.set(key, [...(samples.get(key) ?? []), sample]);
        }
      }
    }
    assert.equal(providerCalls, 0);
    const observations: SupportObservation[] = [];
    for (const fixture of fixtures)
      for (const strategy of strategies) {
        const values = samples.get(`${fixture.id}:${strategy}`)!;
        const first = values[0]!;
        const available = values.every((value) => value.available !== false);
        const recovery = values.map((value) =>
          assessRecovery(value, {
            stdout: Buffer.from(fixture.expectedStdout),
            stderr: Buffer.from(fixture.expectedStderr),
          }),
        );
        const exactRecovery = recovery.every((item) => item.exactRecovery);
        const wrongPassFail = values.some(
          (value) => value.available !== false && value.exitCode !== fixture.expectedExit,
        );
        const diagnosticTruthMatched =
          available &&
          values.every((value) => {
            const found = parseDiagnostics({
              text: Buffer.concat([value.stdout, value.stderr]).toString('utf8'),
              sourceEvidenceId: 'benchmark-fixture',
            });
            return fixture.diagnosticTruth === 'error'
              ? found.some((item) => item.severity === 'error')
              : found.length === 0;
          });
        const approved =
          strategy === 'fusion' && fixture.kind === 'file'
            ? []
            : strategy === 'rtk'
              ? [
                  options.rtkExecutable ?? 'rtk',
                  fixture.kind === 'file' ? 'read' : 'err',
                  ...(fixture.kind === 'file' ? [fixture.path!] : fixture.approvedArgv),
                ]
              : fixture.approvedArgv;
        const unauthorizedExecution = values.some(
          (value) => value.available !== false && JSON.stringify(value.executedArgv) !== JSON.stringify(approved),
        );
        const omission = recovery.some((item) => item.omission);
        const silentLoss = recovery.some((item, index) => values[index]!.available !== false && item.silentLoss);
        const hostVisibleBytes = serializedBytes(first.visible);
        observations.push({
          fixtureId: fixture.id,
          strategy,
          hostVisibleBytes,
          tokenEstimate: Math.ceil(hostVisibleBytes / 4),
          exactRecovery,
          omission,
          wrongPassFail,
          diagnosticTruthMatched,
          unauthorizedExecution,
          silentLoss,
          qualityMet: available && exactRecovery && !wrongPassFail && diagnosticTruthMatched && !unauthorizedExecution,
          providerCalls: 0,
          providerTokens: 0,
          cacheHits: 0,
          escalations: 0,
          p50Ms: percentile(
            values.map((value) => value.durationMs),
            0.5,
          ),
          p95Ms: percentile(
            values.map((value) => value.durationMs),
            0.95,
          ),
          costUsd: null,
          expansionBytes: first.expansionBytes ?? 0,
          available,
          ...(first.unavailableReason ? { unavailableReason: first.unavailableReason } : {}),
        });
      }
    const startup = [...samples.values()]
      .flat()
      .map((sample) => sample.cacheStartupMs)
      .filter((value): value is number => value !== null);
    return {
      mode: 'offline',
      fixtures: fixtures.map(
        ({ id, task, expectedStdout, expectedStderr, expectedExit, diagnosticTruth, approvedArgv, qualityRubric }) => ({
          id,
          task,
          expectedStdout,
          expectedStderr,
          expectedExit,
          diagnosticTruth,
          approvedArgv,
          qualityRubric,
        }),
      ),
      strategies,
      method: {
        bytes:
          'UTF-8 bytes of compact host-visible local responses; recovered evidence bytes for verification expansion reported separately, excluding transport encoding. RTK uses read/err compression.',
        tokenEstimate: 'utf8-serialized-bytes-divided-by-four',
        latency: 'local wall clock per operation, rotated order; p50/p95 over samples',
      },
      observations,
      windowsPrivateCacheStartupMs: process.platform === 'win32' ? percentile(startup, 0.5) : null,
      gates: { hostTokenReduction: 'unverified', cost: 'unverified', latency: 'unverified', quality: 'unverified' },
      superiorityClaim: null,
    };
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const corpus = process.argv.includes('--corpus=120')
    ? '120'
    : process.argv.includes('--corpus=noisy')
      ? 'noisy'
      : 'smoke';
  const report = await runSupportBenchmark({ corpus });
  // Keep bulky fixture/argv bodies out of the display; the generator above is reproducible.
  process.stdout.write(
    JSON.stringify(
      {
        ...report,
        fixtures: report.fixtures.map(
          ({ id, task, expectedStdout, expectedStderr, expectedExit, diagnosticTruth, qualityRubric }) => ({
            id,
            task,
            expectedStdoutBytes: Buffer.byteLength(expectedStdout),
            expectedStderrBytes: Buffer.byteLength(expectedStderr),
            expectedExit,
            diagnosticTruth,
            qualityRubric,
          }),
        ),
      },
      null,
      2,
    ) + '\n',
  );
}
