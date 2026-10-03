import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';

export interface OAuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  ownerSubject: string;
  scopes: string[];
}

/** Verify access tokens only; never accept ID tokens or credentials for another resource. */
export function createTokenVerifier(
  config: OAuthConfig,
  keys?: JWTVerifyGetKey,
): (token: string) => Promise<JWTPayload> {
  const keySet = keys ?? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5_000 });
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
      requiredClaims: ['exp', 'sub', 'iss', 'aud'],
    });
    if (payload.sub !== config.ownerSubject) throw new Error('Unauthorized owner');
    const scopes = new Set(typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : []);
    if (!config.scopes.every((scope) => scopes.has(scope))) throw new Error('Insufficient scope');
    return payload;
  };
}
