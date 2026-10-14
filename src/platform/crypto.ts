import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

export const newId = (): string => uuidv7();

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** URL-safe high-entropy token. Only the SHA-256 is ever stored. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Versioned key source for AES-256-GCM; swap for a KMS-backed provider in production. */
export interface KeyProvider {
  current(): { version: number; key: Buffer };
  get(version: number): Buffer;
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<number, Buffer>();
  private readonly currentVersion: number;
  /** `keys` format: "1:<64hex>,2:<64hex>"; or a single 64-hex key (version 1). */
  constructor(spec: string) {
    for (const part of spec.split(',')) {
      const [v, k] = part.includes(':') ? part.split(':') : ['1', part];
      const buf = Buffer.from(k as string, 'hex');
      if (buf.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes of hex');
      this.keys.set(Number(v), buf);
    }
    this.currentVersion = Math.max(...this.keys.keys());
  }
  current() {
    return { version: this.currentVersion, key: this.keys.get(this.currentVersion) as Buffer };
  }
  get(version: number): Buffer {
    const k = this.keys.get(version);
    if (!k) throw new Error(`Unknown encryption key version ${version}`);
    return k;
  }
}

/** Output format: v<version>.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(provider: KeyProvider, plaintext: string): string {
  const { version, key } = provider.current();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return [`v${version}`, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(provider: KeyProvider, payload: string): string {
  const [v, iv, tag, ct] = payload.split('.');
  if (!v || !iv || !tag || !ct) throw new Error('Malformed ciphertext');
  const d = createDecipheriv('aes-256-gcm', provider.get(Number(v.slice(1))), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
