import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/concurrency.js';
import { deferred } from './deferred.js';

test('cancelling a permit during handoff neither strands queued calls nor starts the cancelled operation', { timeout: 2000 }, async () => {
  const semaphore = new Semaphore(1);
  const normal = new AbortController().signal;
  const cancelled = new AbortController();
  const gate = deferred();
  const order: string[] = [];
  const first = semaphore.use(() => gate.promise, normal);
  const second = semaphore.use(async () => { order.push('cancelled'); }, cancelled.signal);
  const rejection = assert.rejects(second, { name: 'AbortError' });
  const third = semaphore.use(async () => { order.push('third'); }, normal);
  gate.resolve();
  // First's finally transfers the permit, then this abort runs before second resumes.
  queueMicrotask(() => cancelled.abort());
  await Promise.all([first, rejection, third]);
  await semaphore.use(async () => { order.push('fourth'); }, normal);
  assert.deepEqual(order, ['third', 'fourth']);
});

test('a new caller cannot steal a permit reserved for a queued operation', { timeout: 2000 }, async () => {
  const semaphore = new Semaphore(1);
  const signal = new AbortController().signal;
  const gate = deferred();
  const secondGate = deferred();
  const secondStarted = deferred();
  const order: number[] = [];
  const first = semaphore.use(() => gate.promise, signal);
  const second = semaphore.use(async () => { order.push(2); secondStarted.resolve(); await secondGate.promise; }, signal);
  let third!: Promise<void>;
  gate.resolve();
  queueMicrotask(() => { third = semaphore.use(async () => { order.push(3); }, signal); });
  await secondStarted.promise;
  assert.deepEqual(order, [2]);
  secondGate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, [2, 3]);
});

test('aborted queued operations are removed and thrown operations release capacity', async () => {
  const semaphore = new Semaphore(1);
  const signal = new AbortController().signal;
  const gate = deferred();
  const first = semaphore.use(() => gate.promise, signal);
  const abort = new AbortController();
  const queued = semaphore.use(async () => assert.fail('must not run'), abort.signal);
  abort.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  gate.resolve(); await first;
  await assert.rejects(semaphore.use(async () => { throw new Error('failure'); }, signal), /failure/);
  assert.equal(await semaphore.use(async () => 42, signal), 42);
});
