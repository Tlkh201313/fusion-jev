import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createTokenVerifier } from '../src/oauth.js';

test('OAuth accepts only signed, unexpired owner tokens for this resource and scope', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const verify = createTokenVerifier({ issuer: 'https://issuer.example', audience: 'https://fusion.example/mcp', jwksUrl: 'https://issuer.example/keys', ownerSubject: 'owner', scopes: ['fusion:route'] }, createLocalJWKSet({ keys: [{ ...jwk, kid: 'key' }] }));
  const token = (claims: Record<string, unknown> = {}) => new SignJWT({ scope: 'fusion:route', sub: 'owner', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'key' }).setIssuer('https://issuer.example').setAudience('https://fusion.example/mcp').setExpirationTime('5m').sign(privateKey);
  assert.equal((await verify(await token())).sub, 'owner');
  await assert.rejects(verify(await token({ sub: 'someone-else' })));
  await assert.rejects(verify(await token({ scope: 'other:scope' })));
  await assert.rejects(verify(await new SignJWT({ sub: 'owner', scope: 'fusion:route' }).setProtectedHeader({ alg: 'RS256', kid: 'key' }).setIssuer('https://issuer.example').setAudience('other').setExpirationTime('5m').sign(privateKey)));
  await assert.rejects(verify(await new SignJWT({ sub: 'owner', scope: 'fusion:route' }).setProtectedHeader({ alg: 'RS256', kid: 'key' }).setIssuer('https://issuer.example').setAudience('https://fusion.example/mcp').setExpirationTime(1).sign(privateKey)));
  await assert.rejects(verify(await new SignJWT({ sub: 'owner', scope: 'fusion:route' }).setProtectedHeader({ alg: 'RS256', kid: 'key' }).setIssuer('https://issuer.example').setAudience('https://fusion.example/mcp').sign(privateKey)));
});
