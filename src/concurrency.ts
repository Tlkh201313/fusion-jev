const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });

/** FIFO permits are transferred before waking a waiter, including cancelled handoffs. */
export class Semaphore {
  private running = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async use<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw cancelled();
    if (this.running >= this.limit)
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.waiting = this.waiting.filter((w) => w !== wake);
          reject(cancelled());
        };
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waiting.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    else this.running++;
    try {
      if (signal.aborted) throw cancelled();
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
