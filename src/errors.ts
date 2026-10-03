import type { UsageRecord } from './types.js';

/** Public messages are deliberately static: never include provider bodies/keys. */
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly usage: UsageRecord[] = [],
    public readonly status?: number,
  ) {
    super(`Provider request failed: ${code}`);
    this.name = 'ProviderError';
  }
}

/** Invalid configuration (environment or env file). The message is already safe to show. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** A mistake in how the CLI was invoked. The message is the usage text shown to the user. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
