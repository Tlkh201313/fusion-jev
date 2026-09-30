import type { UsageRecord } from './types.js';

/** Public messages are deliberately static: never include provider bodies/keys. */
export class ProviderError extends Error {
  constructor(public readonly code: string, public readonly usage: UsageRecord[] = [], public readonly status?: number) {
    super(`Provider request failed: ${code}`);
    this.name = 'ProviderError';
  }
}
