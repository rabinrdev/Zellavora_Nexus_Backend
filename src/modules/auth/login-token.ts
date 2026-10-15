import { createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { encrypt, decrypt, type KeyProvider } from '../../platform/crypto.js';

/** Lifetime of a token from `GET /auth/gettoken`. */
export const LOGIN_TOKEN_TTL_SECONDS = 300;

const invalid = (field: 'token' | 'data') =>
  new AppError('VALIDATION_FAILED', 'The encrypted login payload could not be read', [{ field, issue: 'invalid_or_expired' }]);

/**
 * Issues a short-lived login token. The AES-256 key and IV are sealed (AES-256-GCM, server key) inside the token,
 * so nothing is stored server-side; the same key/IV are returned in the clear (base64) for the client to encrypt
 * the login payload with crypto-js (AES-CBC, PKCS7).
 */
export function issueLoginToken(keys: KeyProvider, now: Date) {
  const key = randomBytes(32).toString('base64');
  const iv = randomBytes(16).toString('base64');
  const exp = Math.floor(now.getTime() / 1000) + LOGIN_TOKEN_TTL_SECONDS;
  return { token: encrypt(keys, JSON.stringify({ k: key, i: iv, e: exp })), key, iv, expiresIn: LOGIN_TOKEN_TTL_SECONDS };
}

/** Opens the token and decrypts `data` (base64 ciphertext produced by CryptoJS.AES.encrypt(...).toString()). */
export function decryptLoginPayload(keys: KeyProvider, now: Date, token: string, data: string): unknown {
  let sealed: { k: string; i: string; e: number };
  try {
    sealed = JSON.parse(decrypt(keys, token));
  } catch {
    throw invalid('token');
  }
  if (typeof sealed.e !== 'number' || sealed.e < Math.floor(now.getTime() / 1000)) throw invalid('token');
  try {
    const d = createDecipheriv('aes-256-cbc', Buffer.from(sealed.k, 'base64'), Buffer.from(sealed.i, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    throw invalid('data');
  }
}

export const loginTokenResponse = z.object({
  token: z.string(), key: z.string(), iv: z.string(), expiresIn: z.number(),
});
