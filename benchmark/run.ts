import { FusionRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { ESCALATE, type ChoiceProvider, type GenerativeProvider, type UsageRecord } from '../src/types.js';
import { runBenchmark } from './core.js';
import { fixtures } from './fixtures.js';

const usage = (provider: 'jev' | 'gpt'): UsageRecord => ({
  provider, model: `simulated-${provider}`, inputTokens: provider === 'jev' ? 12 : 36,
  cachedInputTokens: 0, outputTokens: provider === 'jev' ? 4 : 8,
  estimatedCostUsd: provider === 'jev' ? 0.00002 : 0.0001,
  estimated: true, costUncertain: false,
});

const jev: ChoiceProvider = { async choose(requests) {
  return { answers: requests.map(request => {
    const choice = request.task.includes('open') ? 'open'
      : request.task.includes('closed') ? 'closed' : ESCALATE;
    return { choice, confidence: choice === ESCALATE ? 0.4 : 0.95,
      probabilities: choice === 'open' ? { open: 0.95, closed: 0.025, [ESCALATE]: 0.025 }
        : choice === 'closed' ? { open: 0.025, closed: 0.95, [ESCALATE]: 0.025 }
          : { open: 0.25, closed: 0.25, [ESCALATE]: 0.5 } };
  }), usage: [usage('jev')] };
} };
const gpt: GenerativeProvider = { async generate(request) {
  const choice = request.task.includes('open') ? 'open'
    : request.task.includes('closed') ? 'closed' : null;
  const candidate = request.candidates.find(candidate => candidate.id === choice);
  return { call: candidate ? { tool: candidate.tool, arguments: candidate.arguments } : null,
    candidateId: candidate?.id, usage: [usage('gpt')] };
} };

const config = loadConfig({ FUSION_FALLBACK: 'gpt' });
const router = new FusionRouter({ config, jev, gpt });
if (process.env.FUSION_LIVE_BENCHMARK === '1') {
  const { runLiveBenchmark } = await import('./live.js');
  await runLiveBenchmark();
} else {
  const report = await runBenchmark(fixtures, request => router.route(request), { pricesConfigured: true });
  process.stdout.write(`${JSON.stringify({ mode: 'offline-simulation', note: 'Synthetic decisions and token/cost figures; no provider accuracy, task success, or savings claim.', report }, null, 2)}\n`);
}
