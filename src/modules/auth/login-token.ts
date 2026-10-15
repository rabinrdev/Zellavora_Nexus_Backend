import { createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { safeEqual, type KeyProvider } from '../../platform/crypto.js';

/** Lifetime of a token from `GET /auth/gettoken`. */
export const LOGIN_TOKEN_TTL_SECONDS = 300;

/** The token is `[key, iv]` as hex strings (64 and 32 chars), the wire format of the control-center backend. */
export const loginTokenSchema = z.array(z.string().regex(/^[0-9a-fA-F]+$/).min(32).max(64)).length(2);
export const loginTokenResponse = z.array(z.string()).min(2).max(2);

const invalid = (field: string) =>
  new AppError('VALIDATION_FAILED', 'The encrypted login fields could not be read', [{ field, issue: 'invalid_or_expired' }]);

/** key = HMAC-SHA256(server key, "login-token" || iv): the server can re-derive and verify it, so nothing is stored. */
const deriveKey = (keys: KeyProvider, iv: Buffer): Buffer =>
  createHmac('sha256', keys.current().key).update('login-token').update(iv).digest();

/**
 * Issues `[key, iv]` as hex strings. The first 4 bytes of the IV are the expiry (unix seconds, big-endian), the
 * other 12 are random. The client uses both to encrypt the login payload with AES-256-CBC (crypto-js).
 */
export function issueLoginToken(keys: KeyProvider, now: Date): [string, string] {
  const iv = Buffer.concat([Buffer.alloc(4), randomBytes(12)]);
  iv.writeUInt32BE(Math.floor(now.getTime() / 1000) + LOGIN_TOKEN_TTL_SECONDS, 0);
  return [deriveKey(keys, iv).toString('hex'), iv.toString('hex')];
}

/** Verifies a `[key, iv]` token (issued by us, not expired) and returns the AES key and IV. */
export function openLoginToken(keys: KeyProvider, now: Date, token: string[]): { key: Buffer; iv: Buffer } {
  const [keyB64, ivB64] = token as [string, string];
  const iv = Buffer.from(ivB64, 'hex');
  if (iv.length !== 16 || iv.readUInt32BE(0) < Math.floor(now.getTime() / 1000)) throw invalid('tokenkeys');
  const key = deriveKey(keys, iv);
  if (!safeEqual(key.toString('hex'), keyB64.toLowerCase())) throw invalid('tokenkeys');
  return { key, iv };
}

/** Decrypts one field (base64 of CryptoJS.AES.encrypt(value, key, { iv }).toString()). */
export function decryptField(k: { key: Buffer; iv: Buffer }, value: string, field: string): string {
  try {
    const d = createDecipheriv('aes-256-cbc', k.key, k.iv);
    return Buffer.concat([d.update(Buffer.from(value, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw invalid(field);
  }
}
