import { ProviderError } from '../errors.js';
import type { ProviderConfig, UsageRecord } from '../types.js';

export type Fetcher = typeof fetch;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function recordUsage(provider: 'jev' | 'gpt', config: ProviderConfig, model: string,
  counts: { inputTokens: number; cachedInputTokens?: number; outputTokens: number } | null,
  approximateInput = 0, uncertain = false): UsageRecord {
  const inputTokens = counts?.inputTokens ?? Math.max(0, Math.ceil(approximateInput / 4));
  const cachedInputTokens = counts?.cachedInputTokens ?? 0;
  const outputTokens = counts?.outputTokens ?? 0;
  return {
    provider, model, inputTokens, cachedInputTokens, outputTokens,
    estimatedCostUsd: ((inputTokens - cachedInputTokens) * config.inputUsdPerMillion
      + cachedInputTokens * config.cachedInputUsdPerMillion
      + outputTokens * config.outputUsdPerMillion) / 1_000_000,
    estimated: counts === null, costUncertain: uncertain || counts === null || config.pricingConfigured === false,
  };
}

export function tokenCounts(value: unknown): { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null {
  if (!isObject(value)) return null;
  const input = value.input_tokens, output = value.output_tokens;
  if (!Number.isSafeInteger(input) || (input as number) < 0 || !Number.isSafeInteger(output) || (output as number) < 0) return null;
  const details = isObject(value.input_tokens_details) ? value.input_tokens_details : null;
  const cached = details?.cached_tokens ?? 0;
  if (!Number.isSafeInteger(cached) || (cached as number) < 0 || (cached as number) > (input as number)) return null;
  return { inputTokens: input as number, cachedInputTokens: cached as number, outputTokens: output as number };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function postJson(config: ProviderConfig, endpoint: string, payload: unknown,
  signal: AbortSignal, fetcher: Fetcher, provider: 'jev' | 'gpt'): Promise<{ body: unknown; bytes: number }> {
  if (!config.apiKey) throw new ProviderError('missing_api_key');
  if (signal.aborted) throw new ProviderError('cancelled');
  const body = JSON.stringify(payload);
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl.replace(/\/$/, '')}${endpoint}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body, signal: combined, redirect: 'error',
    });
  } catch {
    throw new ProviderError(signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network',
      [recordUsage(provider, config, config.model, null, body.length, true)]);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'http_error',
      [recordUsage(provider, config, config.model, null, body.length, true)], response.status);
  }
  if (!response.body) throw new ProviderError('malformed_response',
    [recordUsage(provider, config, config.model, null, body.length, true)]);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError('response_too_large', [recordUsage(provider, config, config.model, null, body.length, true)]);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network',
      [recordUsage(provider, config, config.model, null, body.length, true)]);
  } finally {
    reader.releaseLock();
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return { body: JSON.parse(decoded) as unknown, bytes: body.length };
  } catch {
    throw new ProviderError('malformed_response', [recordUsage(provider, config, config.model, null, body.length, true)]);
  }
}
