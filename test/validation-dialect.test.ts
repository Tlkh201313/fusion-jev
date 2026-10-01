import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTools } from '../src/validation.js';

test('tool schemas declaring draft 2020-12 compile and validate', () => {
  const validators = compileTools([{ name: 'lookup', description: 'Lookup', inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }]);
  assert.ok(validators);
  const validate = validators.get('lookup')!;
  assert.equal(validate({ id: 'a' }), true);
  assert.equal(validate({}), false);
});
