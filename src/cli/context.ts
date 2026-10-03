import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where the running CLI lives. `selfUrl` is the entry module's import.meta.url (src/cli.ts under tsx, dist/cli.js when built). */
export interface CliContext { selfUrl: string }

export const selfPath = (context: CliContext): string => fileURLToPath(context.selfUrl);

/** The package.json next to the entry module's directory (one level above src/ or dist/). */
export const packageVersion = (context: CliContext): unknown =>
  JSON.parse(readFileSync(new URL('../package.json', context.selfUrl), 'utf8')).version;

export const builtCliPath = (context: CliContext): string => fileURLToPath(new URL('../dist/cli.js', context.selfUrl));
