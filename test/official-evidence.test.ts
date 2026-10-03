import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore } from '../src/evidence.js';

test('official direct keys are redacted from each supported assignment format', async () => {
  const store = new EvidenceStore();
  const input =
    'TYPESAFE_API_KEY=plain-private\nJEV_API_KEY=alias-private\n{"TYPESAFE_API_KEY":"json-private"}\n\'JEV_API_KEY\':\'quoted-private\'\n';
  const receipt = store.capture({
    source: { kind: 'command', cwd: process.cwd(), argv: ['node'], channel: 'stdout' },
    bytes: Buffer.from(input),
  });
  assert.equal(receipt.redacted, true);
  const page = await store.expand({ id: receipt.id });
  assert.equal(page.status, 'ok');
  if (page.status === 'ok') {
    const text = Buffer.from(page.dataBase64, 'base64').toString();
    assert.doesNotMatch(text, /plain-private|alias-private|json-private|quoted-private/);
    assert.equal(text.split('[REDACTED]').length - 1, 4);
  }
});
