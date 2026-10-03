/** Poll predicate every intervalMs until it returns truthy or timeoutMs elapses (then throw). */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 20, message = 'waitFor condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
