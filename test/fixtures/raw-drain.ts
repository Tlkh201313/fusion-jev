import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { EvidenceStore } from '../../src/evidence.js';
import { runCommand } from '../../src/run.js';

const bytes: Buffer[] = [];
let peakQueued = 0;
const sink = new Writable({
  highWaterMark: 1,
  write(chunk: Buffer, _encoding, callback) {
    bytes.push(Buffer.from(chunk));
    peakQueued = Math.max(peakQueued, sink.writableLength);
    setTimeout(callback, 8);
  },
});
const descriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
Object.defineProperty(process, 'stdout', { configurable: true, value: sink });
try {
  const result = await runCommand({ argv: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(1024*1024,0x5a))'], raw: true, maxCaptureBytes: 1024 }, new EvidenceStore());
  const actual = Buffer.concat(bytes);
  process.stderr.write(JSON.stringify({ exitCode: result.exitCode, storedBytes: result.stdout.storedBytes,
    originalBytes: result.stdout.originalBytes, queuedAtReturn: sink.writableLength, peakQueued,
    byteLength: actual.length, sha256: createHash('sha256').update(actual).digest('hex') }));
} finally {
  if (descriptor) Object.defineProperty(process, 'stdout', descriptor);
}
