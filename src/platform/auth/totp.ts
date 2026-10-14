import { generateSecret, generateURI, verifySync, generateSync } from 'otplib';

export const newTotpSecret = (): string => generateSecret();

export function totpUri(secret: string, email: string): string {
  return generateURI({ issuer: 'Zellavora Nexus', label: email, secret });
}

export function verifyTotp(secret: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  try {
    const r = verifySync({ secret, token, epochTolerance: 30 } as never) as unknown;
    return typeof r === 'boolean' ? r : !!(r as { valid?: boolean }).valid;
  } catch {
    return false;
  }
}

/** Test helper / support tooling. */
export const currentTotp = (secret: string): string => generateSync({ secret });
