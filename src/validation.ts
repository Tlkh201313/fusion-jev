import AjvModule, { type ValidateFunction } from 'ajv';
import { ESCALATE, type Candidate, type JsonObject, type JsonSchema, type JsonValue, type PreparedRequest, type ReasonCode, type RouteRequest, type ToolCall, type ToolDefinition, type FusionConfig } from './types.js';

const Ajv = AjvModule as unknown as new (options: Record<string, unknown>) => {
  validateSchema(schema: object): boolean;
  compile(schema: object): ValidateFunction;
};
type Prepared = { request?: PreparedRequest; reason?: ReasonCode; enumeration?: 'explicit' | 'finite' | 'unsupported' };

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonSafe(value: unknown): boolean {
  return isJsonValue(value);
}

export function compileTools(tools: ToolDefinition[]): Map<string, ValidateFunction> | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) {
    if (!plainObject(tool) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name === ESCALATE || validators.has(tool.name)
      || typeof tool.description !== 'string' || !plainObject(tool.inputSchema)) return null;
    try {
      // MCP hosts and zod emit draft 2020-12 $schema URIs; validate the schema body with
      // the bundled draft instead of rejecting every such tool.
      const { $schema: _dialect, ...schema } = tool.inputSchema as Record<string, unknown>;
      const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: true });
      if (!ajv.validateSchema(schema)) return null;
      validators.set(tool.name, ajv.compile(schema));
    } catch { return null; }
  }
  return validators;
}

export function validateCall(call: unknown, tools: ToolDefinition[]): call is ToolCall {
  if (!plainObject(call) || typeof call.tool !== 'string' || !plainObject(call.arguments) || !jsonSafe(call.arguments)) return false;
  const validator = compileTools(tools)?.get(call.tool);
  return !!validator && validator(call.arguments) === true;
}

export function prepareRequest(raw: RouteRequest, config: FusionConfig): Prepared {
  if (!plainObject(raw) || typeof raw.task !== 'string' || !raw.task.trim() || !Array.isArray(raw.tools)
    || !jsonSafe(raw) || Buffer.byteLength(JSON.stringify(raw), 'utf8') > config.routing.maxRequestBytes) {
    return { reason: 'invalid_request' };
  }
  if (raw.strategy !== undefined && !['fusion', 'jev-only', 'gpt-only'].includes(raw.strategy)) return { reason: 'invalid_request' };
  if (raw.cache !== undefined && typeof raw.cache !== 'boolean') return { reason: 'invalid_request' };
  const validators = compileTools(raw.tools);
  if (!validators) return { reason: 'invalid_schema' };
  let candidates: Candidate[];
  let enumeration: NonNullable<Prepared['enumeration']>;
  if (raw.candidates !== undefined) {
    if (!Array.isArray(raw.candidates)) return { reason: 'invalid_candidate' };
    candidates = raw.candidates;
    enumeration = 'explicit';
  } else {
    const enumerated = enumerateCandidates(raw.tools, config.routing.maxCandidates, validators);
    candidates = enumerated ?? [];
    enumeration = enumerated === null ? 'unsupported' : 'finite';
  }
  if (candidates.length > config.routing.maxCandidates || candidates.length > 254) return { reason: 'candidate_limit' };
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!plainObject(candidate) || typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id === ESCALATE || ids.has(candidate.id)
      || typeof candidate.tool !== 'string' || !plainObject(candidate.arguments) || !jsonSafe(candidate.arguments)
      || validators.get(candidate.tool)?.(candidate.arguments) !== true) return { reason: 'invalid_candidate' };
    ids.add(candidate.id);
  }
  return { request: { ...raw, strategy: raw.strategy ?? 'fusion', candidates }, enumeration };
}

/** Null means the complete space cannot be proved finite within the cap. */
export function enumerateCandidates(tools: ToolDefinition[], limit: number,
  validators: Map<string, ValidateFunction> | null = compileTools(tools)): Candidate[] | null {
  const result: Candidate[] = [];
  if (!validators) return null;
  for (const tool of tools) {
    const values = enumerateValue(tool.inputSchema, limit - result.length);
    if (values === null) return null;
    for (const value of values) {
      if (!plainObject(value)) return null;
      if (validators.get(tool.name)!(value) !== true) continue;
      result.push({ id: `c${result.length + 1}`, tool: tool.name, arguments: value as JsonObject });
      if (result.length > limit) return null;
    }
  }
  return result;
}

function enumerateValue(schema: JsonSchema, limit: number): JsonValue[] | null {
  if (!plainObject(schema) || limit < 1) return null;
  if ('const' in schema) return isJsonValue(schema.const) ? [schema.const] : null;
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length > limit || !schema.enum.every(value => isJsonValue(value))) return null;
    return schema.enum;
  }
  if (schema.type === 'boolean') return limit >= 2 ? [false, true] : null;
  if (schema.type !== 'object' || schema.additionalProperties !== false || !plainObject(schema.properties)) return null;
  const unsupported = ['oneOf', 'anyOf', 'allOf', 'not', 'patternProperties', 'propertyNames', 'dependencies', 'dependentSchemas', 'dependentRequired', 'if', 'then', 'else', '$ref'];
  if (unsupported.some(key => key in schema)) return null;
  const required = Array.isArray(schema.required) && schema.required.every(x => typeof x === 'string') ? schema.required as string[] : [];
  const keys = Object.keys(schema.properties);
  if (required.some(key => !keys.includes(key))) return null;
  let rows: JsonObject[] = [{}];
  for (const key of keys) {
    const propertySchema = schema.properties[key];
    if (!plainObject(propertySchema)) return null;
    const values = enumerateValue(propertySchema, limit);
    if (values === null) return null;
    const options: Array<JsonValue | undefined> = required.includes(key) ? values : [undefined, ...values];
    if (rows.length * options.length > limit) return null;
    rows = rows.flatMap(row => options.map(value => value === undefined ? { ...row } : { ...row, [key]: value }));
  }
  return rows;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value) ? value.every(item => isJsonValue(item, seen))
    : plainObject(value) && Object.values(value).every(item => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}
