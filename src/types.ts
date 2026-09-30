export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** An execution host must use its own trusted registry for authorization. */
  readOnly?: boolean;
}
export interface ToolCall { tool: string; arguments: JsonObject }
export interface Candidate extends ToolCall { id: string; description?: string }
export type Strategy = 'fusion' | 'gpt-only' | 'jev-only';
export interface RouteRequest {
  task: string;
  context?: JsonValue;
  tools: ToolDefinition[];
  /** Omit to enumerate finite schemas. An empty array requests GPT generation. */
  candidates?: Candidate[];
  strategy?: Strategy;
  cache?: boolean;
}
export interface PreparedRequest extends RouteRequest {
  candidates: Candidate[];
  strategy: Strategy;
}
export type ReasonCode =
  | 'invalid_request' | 'invalid_schema' | 'invalid_candidate' | 'candidate_limit'
  | 'unsupported_schema' | 'no_candidates' | 'low_confidence' | 'low_probability'
  | 'low_margin' | 'model_escalated' | 'invalid_response' | 'provider_error'
  | 'circuit_open' | 'cancelled' | 'timeout' | 'no_fallback';
export type ProviderFailureCategory = 'authentication' | 'rate_limit' | 'network' | 'timeout' | 'malformed_response' | 'configuration' | 'unavailable' | 'cancelled' | 'unknown';
interface DecisionMetrics {
  failureCategory?: ProviderFailureCategory;
  confidence?: number;
  probability?: number;
  margin?: number;
  requiresApproval?: boolean;
  reuse?: 'cache' | 'inflight';
}
export type Decision =
  | (DecisionMetrics & { status: 'selected'; source: 'jev' | 'gpt'; call: ToolCall; candidateId?: string; reason?: never })
  | (DecisionMetrics & { status: 'escalate'; source: 'host' | 'none'; reason: ReasonCode; call?: never; candidateId?: never })
  | (DecisionMetrics & { status: 'invalid'; source: 'none'; reason: ReasonCode; call?: never; candidateId?: never });
export interface UsageRecord {
  provider: 'jev' | 'gpt';
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  /** True when token counts are an approximation, rather than API usage. */
  estimated: boolean;
  /** A failed request may have unknown billable output or provider charges. */
  costUncertain: boolean;
}
export interface RouteResult {
  decision: Decision;
  usage: UsageRecord[];
  latencyMs: number;
}
export interface BatchResult {
  decisions: Decision[];
  usage: UsageRecord[];
  latencyMs: number;
}
export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ChoiceBatch { answers: ChoiceAnswer[]; usage: UsageRecord[] }
export interface GenerationResult { call: ToolCall | null; candidateId?: string; usage: UsageRecord[] }
export interface ChoiceProvider {
  choose(requests: PreparedRequest[], signal: AbortSignal): Promise<ChoiceBatch>;
}
export interface GenerativeProvider {
  generate(request: PreparedRequest, signal: AbortSignal): Promise<GenerationResult>;
}
export interface ProviderConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** false when environment prices are absent; omitted for explicitly constructed legacy configs. */
  pricingConfigured?: boolean;
}
export interface FusionConfig {
  mcpProfile: 'assist' | 'full';
  jev: ProviderConfig;
  gpt: ProviderConfig & { maxOutputTokens: number; reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' };
  routing: {
    fallback: 'host' | 'gpt';
    minConfidence: number;
    minProbability: number;
    minMargin: number;
    maxCandidates: number;
    maxBatchSize: number;
    maxRequestBytes: number;
    totalTimeoutMs: number;
    maxConcurrency: number;
    cacheTtlMs: number;
    cacheMaxEntries: number;
    breakerThreshold: number;
    breakerCooldownMs: number;
  };
  http: {
    host: string;
    port: number;
    /** A configured root alone never exposes files to remote clients. */
    enableWorkspace: boolean;
    bearerToken?: string;
    allowUnauthenticated: boolean;
    allowedHosts: string[];
    allowedOrigins: string[];
    maxBodyBytes: number;
    maxResearchBodyBytes?: number;
    publicUrl?: string;
    oauth?: {
      issuer: string;
      audience: string;
      jwksUrl: string;
      ownerSubject: string;
      scopes: string[];
    };
  };
  catalog: ToolDefinition[];
}

export const ESCALATE = '__escalate__';
