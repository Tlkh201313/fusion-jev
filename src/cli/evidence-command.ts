import { StorageVerification } from '../acl.js';
import { EvidenceStore } from '../evidence.js';
import { parseEvidenceArgs } from './args.js';
import { evidenceStorageDir } from './storage.js';

/** `fusion-jev evidence ID`: prints one page as JSON, or with --raw every remaining byte verbatim. */
export async function evidenceCli(args: string[]): Promise<void> {
  const { id, raw, startByte, maxBytes } = parseEvidenceArgs(args);
  // Verification of the private cache starts now and is overlapped with building the store.
  const verification = new StorageVerification(evidenceStorageDir());
  const store = new EvidenceStore({ verifiedStorage: await verification.ready() });
  const page = await store.expand({ id, startByte, maxBytes });
  if (page.status !== 'ok' && page.status !== 'stale') throw new Error(`Evidence ${page.status}`);
  if (raw) {
    process.stdout.write(Buffer.from(page.dataBase64, 'base64'));
    let nextByte = page.nextByte;
    while (nextByte !== null) {
      const next = await store.expand({ id, startByte: nextByte, maxBytes });
      if (next.status !== 'ok' && next.status !== 'stale') throw new Error(`Evidence ${next.status}`);
      process.stdout.write(Buffer.from(next.dataBase64, 'base64'));
      nextByte = next.nextByte;
    }
  } else process.stdout.write(JSON.stringify(page) + '\n');
}
