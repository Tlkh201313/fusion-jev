import { ProviderError } from '../errors.js';
import { LIMITS } from '../limits.js';
import {
  ESCALATE,
  type ChoiceAnswer,
  type ChoiceBatch,
  type ChoiceProvider,
  type PreparedRequest,
  type ProviderConfig,
} from '../types.js';
import { isObject, postJson, recordUsage, tokenCounts, type Fetcher } from './http.js';

export class JevProvider implements ChoiceProvider {
  constructor(
    private readonly config: ProviderConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async choose(requests: PreparedRequest[], signal: AbortSignal): Promise<ChoiceBatch> {
    if (requests.length === 0) return { answers: [], usage: [] };
    const questions: Record<string, unknown> = Object.create(null);
    const state: unknown[] = [];
    for (const [i, request] of requests.entries()) {
      if (request.candidates.length === 0) throw new ProviderError('no_candidates');
      if (request.candidates.length > LIMITS.maxCandidates) throw new ProviderError('too_many_candidates');
      const criteria: Record<string, string> = Object.create(null);
      const sharedCriteria: Record<string, string> = Object.create(null);
      for (const candidate of request.candidates) {
        if (!candidate.id || candidate.id === ESCALATE || Object.hasOwn(criteria, candidate.id))
          throw new ProviderError('invalid_candidates');
        const description =
          candidate.description ??
          request.tools.find((tool) => tool.name === candidate.tool)?.description ??
          candidate.tool;
        criteria[candidate.id] = `${candidate.tool}: ${description}. Arguments: ${JSON.stringify(candidate.arguments)}`;
        const detail = candidate.description ? `; ${candidate.description}` : '';
        sharedCriteria[candidate.id] = `${candidate.tool}${detail}; args=${JSON.stringify(candidate.arguments)}`;
      }
      criteria[ESCALATE] = 'No candidate is appropriate; ask the host to decide.';
      sharedCriteria[ESCALATE] = criteria[ESCALATE]!;
      const plainState = { task: request.task, context: request.context ?? null };
      const sharedState = {
        ...plainState,
        tools: Object.fromEntries(request.tools.map((tool) => [tool.name, tool.description])),
      };
      // For small choices the original prompt is cheaper and already verified.
      // Share tool meanings only when that actually reduces the serialized request.
      const shared =
        request.candidates.length >= 4 &&
        JSON.stringify([sharedState, sharedCriteria]).length < JSON.stringify([plainState, criteria]).length;
      state.push(shared ? sharedState : plainState);
      questions[`q${i}`] = {
        type: 'choice',
        instructions: {
          task: request.task,
          question: shared
            ? `Use the context and tool descriptions in state[${i}]. Choose the single best candidate ID for this task, or escalate if none is suitable.`
            : `Use the context in state[${i}]. Choose the single best candidate ID for this task, or escalate if none is suitable.`,
        },
        criteria: shared ? sharedCriteria : criteria,
      };
    }
    const wire = await postJson(
      this.config,
      '/v1/systemone',
      { model: this.config.model, state, questions },
      signal,
      this.fetcher,
      'jev',
    );
    const parsed = wire.body;
    const model = isObject(parsed) && typeof parsed.model === 'string' ? parsed.model : this.config.model;
    const counts = isObject(parsed) ? tokenCounts(parsed.usage) : null;
    const usage = [recordUsage('jev', this.config, model, counts, wire.bytes, !counts)];
    const malformed = () => new ProviderError('malformed_response', usage);
    if (
      !isObject(parsed) ||
      !isObject(parsed.answers) ||
      typeof parsed.model !== 'string' ||
      !counts ||
      Object.keys(parsed.answers).length !== requests.length
    )
      throw malformed();
    const answers: ChoiceAnswer[] = [];
    for (const [i, request] of requests.entries()) {
      const answer = parsed.answers[`q${i}`];
      if (
        !isObject(answer) ||
        answer.type !== 'choice' ||
        typeof answer.choice !== 'string' ||
        !isObject(answer.probabilities) ||
        typeof answer.confidence !== 'number' ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      )
        throw malformed();
      const expected = new Set([...request.candidates.map((candidate) => candidate.id), ESCALATE]);
      if (!expected.has(answer.choice) || Object.keys(answer.probabilities).length !== expected.size) throw malformed();
      let sum = 0;
      const probabilities: Record<string, number> = Object.create(null);
      for (const id of expected) {
        const p = answer.probabilities[id];
        if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw malformed();
        probabilities[id] = p;
        sum += p;
      }
      const choice = answer.choice;
      if (
        Math.abs(sum - 1) > 0.001 ||
        Object.entries(probabilities).some(([id, p]) => id !== choice && p > probabilities[choice]! + 1e-9)
      )
        throw malformed();
      answers.push({ choice, confidence: answer.confidence, probabilities });
    }
    return { answers, usage };
  }
}
