import { FusionRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { JevProvider } from '../src/providers/jev.js';
import { GptProvider } from '../src/providers/gpt.js';
import { runBenchmark } from './core.js';
import { fixtures } from './fixtures.js';

/** Explicitly opt in: this invokes billable provider APIs using the same fixtures as offline mode. */
export async function runLiveBenchmark(): Promise<void> {
  if (process.env.FUSION_LIVE_BENCHMARK !== '1') {
    process.stderr.write('Set FUSION_LIVE_BENCHMARK=1 to allow billable live provider requests.\n');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig({ ...process.env, FUSION_FALLBACK: 'gpt' });
  if (!config.jev.apiKey || !config.gpt.apiKey) {
    process.stderr.write('TYPESAFE_API_KEY and OPENAI_API_KEY are required.\n');
    process.exitCode = 2;
    return;
  }
  const router = new FusionRouter({ config, jev: new JevProvider(config.jev), gpt: new GptProvider(config.gpt) });
  const pricesConfigured = [config.jev, config.gpt].every(provider =>
    provider.inputUsdPerMillion > 0 && provider.outputUsdPerMillion > 0);
  const report = await runBenchmark(fixtures, request => router.route(request), { pricesConfigured });
  process.stdout.write(`${JSON.stringify({ mode: 'live', note: 'Small fixed fixture set; task success is unmeasured because tools are not executed.', report }, null, 2)}\n`);
}
