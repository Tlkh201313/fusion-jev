import type { BenchmarkCase } from './core.js';

const tools = [
  {
    name: 'issues',
    description: 'List project issues',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { state: { enum: ['open', 'closed'] } },
      required: ['state'],
      additionalProperties: false,
    },
  },
];
const candidates = [
  { id: 'open', tool: 'issues', arguments: { state: 'open' } },
  { id: 'closed', tool: 'issues', arguments: { state: 'closed' } },
];

/** Identical fixed cases are used by the offline simulation and opt-in live run. */
export const fixtures: BenchmarkCase[] = [
  {
    task: 'List all currently open project issues',
    tools,
    candidates,
    expected: { tool: 'issues', arguments: { state: 'open' } },
  },
  {
    task: 'List the resolved, closed project issues',
    tools,
    candidates,
    expected: { tool: 'issues', arguments: { state: 'closed' } },
  },
  { task: 'The project has a status dashboard. Which issues should I inspect?', tools, candidates, expected: null },
];
