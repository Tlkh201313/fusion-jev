import { ConfigError } from './errors.js';
import { LIMITS } from './limits.js';
import type { FusionConfig, ToolDefinition } from './types.js';

type Environment = Record<string, string | undefined>;

function integer(value: string | undefined, fallback: number, name: string, minimum = 0): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new ConfigError(`Invalid ${name}`);
  return parsed;
}

function decimal(value: string | undefined, fallback: number, name: string, minimum = 0, maximum = Number.POSITIVE_INFINITY): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new ConfigError(`Invalid ${name}`);
  return parsed;
}

function boolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new ConfigError(`Invalid ${name}`);
}

function choices<T extends string>(value: string | undefined, fallback: T, allowed: readonly T[], name: string): T {
  if (value === undefined || value === '') return fallback;
  if (allowed.includes(value as T)) return value as T;
  throw new ConfigError(`Invalid ${name}`);
}

function list(value: string | undefined): string[] {
  return value?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
}

export function loadConfig(env: Environment = process.env): FusionConfig {
  if (env.JEV_BASE_URL && env.JEV_BASE_URL !== 'https://api.typesafe.ai')
    throw new ConfigError('JEV_BASE_URL must be https://api.typesafe.ai for official Jev');
  if (env.JEV_MODEL && !/^(?:jev-latest|jev-preview|jev-\d+\.\d+\.\d+)$/.test(env.JEV_MODEL))
    throw new ConfigError('JEV_MODEL must be an official Jev alias or versioned model ID');
  if (env.TYPESAFE_API_KEY && env.JEV_API_KEY && env.TYPESAFE_API_KEY !== env.JEV_API_KEY)
    throw new ConfigError('Conflicting TYPESAFE_API_KEY and JEV_API_KEY settings');
  const oauthValues = [env.FUSION_OAUTH_ISSUER, env.FUSION_OAUTH_AUDIENCE, env.FUSION_OAUTH_JWKS_URL, env.FUSION_OAUTH_OWNER_SUBJECT];
  const oauthCount = oauthValues.filter(Boolean).length;
  if (oauthCount > 0 && oauthCount !== oauthValues.length) throw new ConfigError('OAuth settings must be complete');
  const config: FusionConfig = {
    mcpProfile: choices(env.FUSION_MCP_PROFILE, 'assist', ['assist', 'full'], 'FUSION_MCP_PROFILE'),
    jev: {
      apiKey: env.TYPESAFE_API_KEY || env.JEV_API_KEY,
      baseUrl: 'https://api.typesafe.ai',
      model: env.JEV_MODEL || 'jev-latest',
      timeoutMs: integer(env.JEV_TIMEOUT_MS, 5000, 'JEV_TIMEOUT_MS', 1),
      inputUsdPerMillion: decimal(env.JEV_INPUT_USD_PER_MILLION, 0, 'JEV_INPUT_USD_PER_MILLION'),
      cachedInputUsdPerMillion: decimal(env.JEV_CACHED_INPUT_USD_PER_MILLION, 0, 'JEV_CACHED_INPUT_USD_PER_MILLION'),
      outputUsdPerMillion: decimal(env.JEV_OUTPUT_USD_PER_MILLION, 0, 'JEV_OUTPUT_USD_PER_MILLION'),
      pricingConfigured: [env.JEV_INPUT_USD_PER_MILLION, env.JEV_CACHED_INPUT_USD_PER_MILLION, env.JEV_OUTPUT_USD_PER_MILLION].every(value => value !== undefined && value !== ''),
    },
    gpt: {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL ?? 'gpt-5.1',
      timeoutMs: integer(env.OPENAI_TIMEOUT_MS, 12000, 'OPENAI_TIMEOUT_MS', 1),
      inputUsdPerMillion: decimal(env.OPENAI_INPUT_USD_PER_MILLION, 0, 'OPENAI_INPUT_USD_PER_MILLION'),
      cachedInputUsdPerMillion: decimal(env.OPENAI_CACHED_INPUT_USD_PER_MILLION, 0, 'OPENAI_CACHED_INPUT_USD_PER_MILLION'),
      outputUsdPerMillion: decimal(env.OPENAI_OUTPUT_USD_PER_MILLION, 0, 'OPENAI_OUTPUT_USD_PER_MILLION'),
      pricingConfigured: [env.OPENAI_INPUT_USD_PER_MILLION, env.OPENAI_CACHED_INPUT_USD_PER_MILLION, env.OPENAI_OUTPUT_USD_PER_MILLION].every(value => value !== undefined && value !== ''),
      maxOutputTokens: integer(env.OPENAI_MAX_OUTPUT_TOKENS, 512, 'OPENAI_MAX_OUTPUT_TOKENS', 1),
      reasoningEffort: choices(env.OPENAI_REASONING_EFFORT, 'low', ['minimal', 'low', 'medium', 'high'], 'OPENAI_REASONING_EFFORT'),
    },
    routing: {
      fallback: choices(env.FUSION_FALLBACK, 'host', ['host', 'gpt'], 'FUSION_FALLBACK'),
      minConfidence: decimal(env.FUSION_MIN_CONFIDENCE, 0.8, 'FUSION_MIN_CONFIDENCE', 0, 1),
      minProbability: decimal(env.FUSION_MIN_PROBABILITY, 0.7, 'FUSION_MIN_PROBABILITY', 0, 1),
      minMargin: decimal(env.FUSION_MIN_MARGIN, 0.2, 'FUSION_MIN_MARGIN', 0, 1),
      maxCandidates: integer(env.FUSION_MAX_CANDIDATES, LIMITS.maxCandidates, 'FUSION_MAX_CANDIDATES', 1),
      maxBatchSize: integer(env.FUSION_MAX_BATCH_SIZE, 16, 'FUSION_MAX_BATCH_SIZE', 1),
      maxRequestBytes: integer(env.FUSION_MAX_REQUEST_BYTES, LIMITS.requestBytes, 'FUSION_MAX_REQUEST_BYTES', 1),
      totalTimeoutMs: integer(env.FUSION_TOTAL_TIMEOUT_MS, 20000, 'FUSION_TOTAL_TIMEOUT_MS', 1),
      maxConcurrency: integer(env.FUSION_MAX_CONCURRENCY, 4, 'FUSION_MAX_CONCURRENCY', 1),
      cacheTtlMs: integer(env.FUSION_CACHE_TTL_MS, 30000, 'FUSION_CACHE_TTL_MS'),
      cacheMaxEntries: integer(env.FUSION_CACHE_MAX_ENTRIES, 256, 'FUSION_CACHE_MAX_ENTRIES'),
      breakerThreshold: integer(env.FUSION_BREAKER_THRESHOLD, 3, 'FUSION_BREAKER_THRESHOLD', 1),
      breakerCooldownMs: integer(env.FUSION_BREAKER_COOLDOWN_MS, 30000, 'FUSION_BREAKER_COOLDOWN_MS', 1),
    },
    http: {
      host: env.FUSION_HTTP_HOST ?? '127.0.0.1',
      port: integer(env.FUSION_HTTP_PORT, 3000, 'FUSION_HTTP_PORT', 1),
      enableWorkspace: boolean(env.FUSION_HTTP_ENABLE_WORKSPACE, false, 'FUSION_HTTP_ENABLE_WORKSPACE'),
      bearerToken: env.FUSION_HTTP_BEARER_TOKEN,
      allowUnauthenticated: boolean(env.FUSION_HTTP_ALLOW_UNAUTHENTICATED, false, 'FUSION_HTTP_ALLOW_UNAUTHENTICATED'),
      allowedHosts: list(env.FUSION_HTTP_ALLOWED_HOSTS),
      allowedOrigins: list(env.FUSION_HTTP_ALLOWED_ORIGINS),
      maxBodyBytes: integer(env.FUSION_HTTP_MAX_BODY_BYTES, LIMITS.httpBodyBytes, 'FUSION_HTTP_MAX_BODY_BYTES', 1),
      // Both limits read FUSION_HTTP_MAX_BODY_BYTES (no separate research variable exists); only the unset defaults differ.
      maxResearchBodyBytes: integer(env.FUSION_HTTP_MAX_BODY_BYTES, LIMITS.researchBodyBytes, 'FUSION_HTTP_MAX_BODY_BYTES', 1),
      publicUrl: env.FUSION_PUBLIC_URL,
      oauth: oauthCount ? {
        issuer: env.FUSION_OAUTH_ISSUER!, audience: env.FUSION_OAUTH_AUDIENCE!,
        jwksUrl: env.FUSION_OAUTH_JWKS_URL!, ownerSubject: env.FUSION_OAUTH_OWNER_SUBJECT!,
        scopes: env.FUSION_OAUTH_SCOPES === undefined ? ['fusion:route'] : list(env.FUSION_OAUTH_SCOPES),
      } : undefined,
    },
    catalog: parseCatalog(env.FUSION_CATALOG_JSON),
  };
  if (config.routing.maxCandidates > LIMITS.maxCandidates) throw new ConfigError('FUSION_MAX_CANDIDATES cannot exceed 254');
  return config;
}

function parseCatalog(raw: string | undefined): ToolDefinition[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new ConfigError('FUSION_CATALOG_JSON must contain an array');
  return value as ToolDefinition[];
}
