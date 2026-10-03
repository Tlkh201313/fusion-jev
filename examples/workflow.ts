import { FusionRouter } from '../src/router.js';
import { FusionExecutor } from '../src/executor.js';
import { loadConfig } from '../src/config.js';
import { ESCALATE, type RouteRequest } from '../src/types.js';

const list = {
  name: 'list_issues',
  description: 'List issue titles',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: { state: { enum: ['open', 'closed'] } },
    required: ['state'],
    additionalProperties: false,
  },
};
const save = {
  name: 'save_report',
  description: 'Save an issue report in memory',
  readOnly: false,
  inputSchema: {
    type: 'object',
    properties: { count: { type: 'integer', minimum: 0 } },
    required: ['count'],
    additionalProperties: false,
  },
};

const router = new FusionRouter({
  config: loadConfig(),
  jev: {
    async choose(requests) {
      return {
        answers: requests.map((request) => ({
          choice: request.candidates[0]!.id,
          confidence: 0.99,
          probabilities: { [request.candidates[0]!.id]: 0.99, [ESCALATE]: 0.01 },
        })),
        usage: [],
      };
    },
  },
});

const saved: number[] = [];
const executor = new FusionExecutor({
  router,
  handlers: [
    {
      definition: list,
      async handle() {
        return ['Fix login', 'Update docs'];
      },
    },
    {
      definition: save,
      async handle(args) {
        saved.push(args.count as number);
        return { saved: true };
      },
    },
  ],
  authorizeWrite: async (call) => call.tool === 'save_report',
});

const outcome = await executor.runWorkflow((history) => {
  if (history.length === 0)
    return {
      task: 'List open issues',
      tools: [list],
      candidates: [{ id: 'list', tool: 'list_issues', arguments: { state: 'open' } }],
    } satisfies RouteRequest;
  if (history.length === 1) {
    const output = history[0]?.execution?.status === 'executed' ? history[0].execution.output : null;
    const count = Array.isArray(output) ? output.length : 0;
    return {
      task: 'Save issue count',
      tools: [save],
      candidates: [{ id: 'save', tool: 'save_report', arguments: { count } }],
    } satisfies RouteRequest;
  }
  return null;
});

console.log(JSON.stringify({ status: outcome.status, steps: outcome.steps.length, saved }, null, 2));
