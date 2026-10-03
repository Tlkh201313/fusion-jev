import { Ajv } from 'ajv';
import {
  ESCALATE,
  type GenerationResult,
  type GenerativeProvider,
  type JsonObject,
  type JsonSchema,
  type PreparedRequest,
  type ProviderConfig,
  type ToolDefinition,
} from '../types.js';
import { isObject, postJson, recordUsage, tokenCounts, type Fetcher } from './http.js';

type GptConfig = ProviderConfig & { maxOutputTokens: number; reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' };
const ajv = new Ajv({ strict: false, allErrors: false });

/** Only pass schemas whose strict function representation has the same argument semantics. */
function strictSchema(schema: unknown): JsonSchema | null {
  if (!isObject(schema)) return null;
  const allowed = new Set([
    'type',
    'description',
    'enum',
    'const',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'anyOf',
  ]);
  if (Object.keys(schema).some((key) => !allowed.has(key))) return null;
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf)) return null;
    const variants = schema.anyOf.map(strictSchema);
    return variants.some((value) => value === null) ? null : { ...schema, anyOf: variants };
  }
  if (schema.type === 'object') {
    if (!isObject(schema.properties) || schema.additionalProperties !== false || !Array.isArray(schema.required))
      return null;
    const names = Object.keys(schema.properties);
    if (schema.required.length !== names.length || names.some((name) => !(schema.required as unknown[]).includes(name)))
      return null;
    const properties: Record<string, JsonSchema> = {};
    for (const name of names) {
      const nested = strictSchema(schema.properties[name]);
      if (!nested) return null;
      properties[name] = nested;
    }
    return { ...schema, properties };
  }
  if (schema.type === 'array') {
    const items = strictSchema(schema.items);
    return items ? { ...schema, items } : null;
  }
  let type = schema.type;
  if (schema.const !== undefined) {
    if (schema.enum !== undefined) return null;
    const constant = schema.const;
    if (constant === null) type = 'null';
    else if (typeof constant === 'string') type = 'string';
    else if (typeof constant === 'number' && Number.isFinite(constant))
      type = Number.isInteger(constant) ? 'integer' : 'number';
    else if (typeof constant === 'boolean') type = 'boolean';
    else return null;
    if (schema.type !== undefined && schema.type !== type && !(schema.type === 'number' && type === 'integer'))
      return null;
    const { const: _constant, ...rest } = schema;
    return { ...rest, type, enum: [constant] };
  }
  if (type === undefined && Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum;
    if (values.every((value) => typeof value === 'string')) type = 'string';
    else if (values.every((value) => typeof value === 'boolean')) type = 'boolean';
    else if (values.every((value) => typeof value === 'number')) type = 'number';
  }
  if (!['string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) return null;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return null;
  return { ...schema, type };
}

function selectOutput(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.output)) return null;
  const messages = body.output.filter((item) => isObject(item) && item.type === 'message');
  if (messages.length !== 1 || body.output.some((item) => isObject(item) && item.type === 'function_call')) return null;
  const message = messages[0];
  if (!isObject(message) || !Array.isArray(message.content) || message.content.length !== 1) return null;
  const content = message.content[0];
  if (!isObject(content) || content.type !== 'output_text' || typeof content.text !== 'string') return null;
  return content.text;
}

export class GptProvider implements GenerativeProvider {
  constructor(
    private readonly config: GptConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async generate(request: PreparedRequest, signal: AbortSignal): Promise<GenerationResult> {
    const none = (usage: GenerationResult['usage'] = []): GenerationResult => ({ call: null, usage });
    const hasCandidates = request.candidates.length > 0;
    const functionSchemas = hasCandidates ? [] : request.tools.map((tool) => strictSchema(tool.inputSchema));
    if (
      !hasCandidates &&
      (request.tools.length === 0 ||
        request.tools.length > 127 ||
        request.tools.some((tool) => tool.name === ESCALATE) ||
        functionSchemas.some((schema) => schema === null))
    )
      return none();
    const input = JSON.stringify({
      task: request.task,
      context: request.context ?? null,
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      candidates: hasCandidates ? request.candidates : undefined,
    });
    const payload: Record<string, unknown> = {
      model: this.config.model,
      store: false,
      input,
      max_output_tokens: this.config.maxOutputTokens,
      reasoning: { effort: this.config.reasoningEffort },
    };
    if (hasCandidates) {
      payload.instructions = `Select exactly one candidateId from the schema. Choose ${ESCALATE} when no candidate safely fits the task. Do not invent tools or arguments.`;
      payload.text = {
        format: {
          type: 'json_schema',
          name: 'fusion_candidate',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              candidateId: { type: 'string', enum: [...request.candidates.map((candidate) => candidate.id), ESCALATE] },
            },
            required: ['candidateId'],
            additionalProperties: false,
          },
        },
      };
    } else {
      payload.instructions = `Call exactly one function. Use ${ESCALATE} if no registered tool safely fits the task. Never call multiple functions.`;
      payload.tools = [
        ...request.tools.map((tool: ToolDefinition, index) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: functionSchemas[index],
          strict: true,
        })),
        {
          type: 'function',
          name: ESCALATE,
          description: 'Escalate to the host without executing a tool.',
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
          strict: true,
        },
      ];
      payload.parallel_tool_calls = false;
      payload.tool_choice = 'required';
    }
    const wire = await postJson(this.config, '/responses', payload, signal, this.fetcher, 'gpt');
    const body = wire.body;
    const model = isObject(body) && typeof body.model === 'string' ? body.model : this.config.model;
    const counts = isObject(body) ? tokenCounts(body.usage) : null;
    const usage = [recordUsage('gpt', this.config, model, counts, wire.bytes, !counts)];
    if (!isObject(body) || body.status !== 'completed') return none(usage);
    if (hasCandidates) {
      const output = selectOutput(body);
      if (output === null) return none(usage);
      let value: unknown;
      try {
        value = JSON.parse(output) as unknown;
      } catch {
        return none(usage);
      }
      if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.candidateId !== 'string')
        return none(usage);
      if (value.candidateId === ESCALATE) return none(usage);
      const candidate = request.candidates.find((item) => item.id === value.candidateId);
      if (!candidate) return none(usage);
      return { call: { tool: candidate.tool, arguments: candidate.arguments }, candidateId: candidate.id, usage };
    }
    if (!Array.isArray(body.output)) return none(usage);
    const calls = body.output.filter((item) => isObject(item) && item.type === 'function_call');
    const messages = body.output.filter((item) => isObject(item) && item.type === 'message');
    if (
      calls.length !== 1 ||
      messages.some(
        (message) =>
          isObject(message) &&
          Array.isArray(message.content) &&
          message.content.some((content) => isObject(content) && content.type === 'refusal'),
      )
    )
      return none(usage);
    const item = calls[0];
    if (!isObject(item) || typeof item.name !== 'string' || typeof item.arguments !== 'string') return none(usage);
    if (item.name === ESCALATE) {
      try {
        const args: unknown = JSON.parse(item.arguments);
        if (isObject(args) && Object.keys(args).length === 0) return none(usage);
      } catch {
        /* Malformed escalation is still non-executable. */
      }
      return none(usage);
    }
    const tool = request.tools.find((tool) => tool.name === item.name);
    if (!tool) return none(usage);
    let args: unknown;
    try {
      args = JSON.parse(item.arguments) as unknown;
    } catch {
      return none(usage);
    }
    if (!isObject(args)) return none(usage);
    try {
      const validate = ajv.compile(tool.inputSchema);
      if (!validate(args)) return none(usage);
    } catch {
      return none(usage);
    }
    return { call: { tool: item.name, arguments: args as JsonObject }, usage };
  }
}
