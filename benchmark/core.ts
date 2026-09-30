import type { RouteRequest, RouteResult, Strategy, ToolCall } from '../src/types.js';

export interface BenchmarkCase extends RouteRequest { expected: ToolCall | null }
export interface StrategyMetrics {
  cases: number;
  coverage: number;
  abstentions: number;
  selectedCallAccuracy: number | null;
  /** Includes correct abstentions. This evaluates routing decisions, not execution. */
  decisionAccuracy: number;
  /** No task execution is performed by this routing benchmark. */
  taskSuccess: null;
  latencyP50Ms: number;
  latencyP95Ms: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  costUncertain: boolean;
}
export type BenchmarkReport = Record<Strategy, StrategyMetrics>;

const strategies: Strategy[] = ['fusion', 'gpt-only', 'jev-only'];
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}
function sameCall(a: ToolCall | null, b: ToolCall | null): boolean {
  return a === null || b === null ? a === b : a.tool === b.tool && JSON.stringify(a.arguments) === JSON.stringify(b.arguments);
}

/** Rotate strategy order per fixture so transient provider effects do not favor one strategy. */
export async function runBenchmark(
  cases: BenchmarkCase[],
  route: (request: RouteRequest, strategy: Strategy) => Promise<RouteResult>,
  options: { pricesConfigured?: boolean } = {},
): Promise<BenchmarkReport> {
  const rows: Record<Strategy, Array<{ item: BenchmarkCase; result: RouteResult }>> = {
    fusion: [], 'gpt-only': [], 'jev-only': [],
  };
  for (const [index, item] of cases.entries()) {
    for (let offset = 0; offset < strategies.length; offset++) {
      const strategy = strategies[(index + offset) % strategies.length]!;
      const { expected: _expected, ...request } = item;
      rows[strategy].push({ item, result: await route({ ...request, strategy, cache: false }, strategy) });
    }
  }
  const report = {} as BenchmarkReport;
  for (const strategy of strategies) {
    const entries = rows[strategy];
    const selected = entries.filter(({ result }) => result.decision.status === 'selected');
    const usage = entries.flatMap(({ result }) => result.usage);
    report[strategy] = {
      cases: entries.length,
      coverage: entries.length ? selected.length / entries.length : 0,
      abstentions: entries.length - selected.length,
      selectedCallAccuracy: selected.length ? selected.filter(({ item, result }) =>
        sameCall(result.decision.status === 'selected' ? result.decision.call : null, item.expected)).length / selected.length : null,
      decisionAccuracy: entries.length ? entries.filter(({ item, result }) =>
        sameCall(result.decision.status === 'selected' ? result.decision.call : null, item.expected)).length / entries.length : 0,
      taskSuccess: null,
      latencyP50Ms: percentile(entries.map(({ result }) => result.latencyMs), 0.5),
      latencyP95Ms: percentile(entries.map(({ result }) => result.latencyMs), 0.95),
      attempts: usage.length,
      inputTokens: usage.reduce((sum, value) => sum + value.inputTokens, 0),
      outputTokens: usage.reduce((sum, value) => sum + value.outputTokens, 0),
      estimatedCostUsd: options.pricesConfigured !== true ? null
        : usage.reduce((sum, value) => sum + value.estimatedCostUsd, 0),
      costUncertain: usage.some(value => value.costUncertain),
    };
  }
  return report;
}
