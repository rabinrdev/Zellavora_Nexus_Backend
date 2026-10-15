import { createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { safeEqual, type KeyProvider } from '../../platform/crypto.js';

/** Lifetime of a token from `GET /auth/gettoken`. */
export const LOGIN_TOKEN_TTL_SECONDS = 300;

/** The token is `[key, iv]` (base64). */
export const loginTokenSchema = z.array(z.string().min(16).max(64)).length(2);
export const loginTokenResponse = z.array(z.string()).min(2).max(2);

const invalid = (field: 'token' | 'data') =>
  new AppError('VALIDATION_FAILED', 'The encrypted login payload could not be read', [{ field, issue: 'invalid_or_expired' }]);

/** key = HMAC-SHA256(server key, "login-token" || iv): the server can re-derive and verify it, so nothing is stored. */
const deriveKey = (keys: KeyProvider, iv: Buffer): Buffer =>
  createHmac('sha256', keys.current().key).update('login-token').update(iv).digest();

/**
 * Issues `[key, iv]` as base64 strings. The first 4 bytes of the IV are the expiry (unix seconds, big-endian), the
 * other 12 are random. The client uses both to encrypt the login payload with AES-256-CBC (crypto-js).
 */
export function issueLoginToken(keys: KeyProvider, now: Date): [string, string] {
  const iv = Buffer.concat([Buffer.alloc(4), randomBytes(12)]);
  iv.writeUInt32BE(Math.floor(now.getTime() / 1000) + LOGIN_TOKEN_TTL_SECONDS, 0);
  return [deriveKey(keys, iv).toString('base64'), iv.toString('base64')];
}

/** Verifies the `[key, iv]` token and decrypts `data` (base64 from CryptoJS.AES.encrypt(...).toString()). */
export function decryptLoginPayload(keys: KeyProvider, now: Date, token: string[], data: string): unknown {
  const [keyB64, ivB64] = token as [string, string];
  const iv = Buffer.from(ivB64, 'base64');
  if (iv.length !== 16 || iv.readUInt32BE(0) < Math.floor(now.getTime() / 1000)) throw invalid('token');
  const key = deriveKey(keys, iv);
  if (!safeEqual(key.toString('base64'), keyB64)) throw invalid('token');
  try {
    const d = createDecipheriv('aes-256-cbc', key, iv);
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw invalid('data');
  }
}
