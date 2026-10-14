import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'zellavora-nexus';
export const ACCESS_TTL_SECONDS = 15 * 60;

/** Claims are deliberately minimal: never roles or permissions (those are resolved server-side). */
export interface AccessClaims {
  sub: string;
  sid: string;
  org: string | null;
  pv: number;
}

export async function signAccessToken(secret: string, c: AccessClaims): Promise<string> {
  return new SignJWT({ sid: c.sid, org: c.org, pv: c.pv })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return {
      sub: payload.sub,
      sid: payload.sid,
      org: typeof payload.org === 'string' ? payload.org : null,
      pv: typeof payload.pv === 'number' ? payload.pv : 0,
    };
  } catch {
    return null;
  }
}
