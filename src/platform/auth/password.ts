import argon2 from 'argon2';

const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, OPTS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

let dummy: string | undefined;
/** Burns equivalent CPU time for unknown accounts so response timing does not reveal existence. */
export async function dummyVerify(plain: string): Promise<void> {
  dummy ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(dummy, plain);
}

export interface PasswordPolicy {
  minLength: number;
  requireClasses: number; // of: lower, upper, digit, symbol
  historyDepth: number;
}
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { minLength: 12, requireClasses: 3, historyDepth: 5 };

const COMMON = new Set(['password1234', 'qwertyuiop12', '123456789012', 'letmein12345', 'administrator1']);

export function passwordProblems(pw: string, policy: PasswordPolicy, ctx: { email?: string; name?: string } = {}): string[] {
  const issues: string[] = [];
  if (pw.length < policy.minLength) issues.push(`must be at least ${policy.minLength} characters`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < policy.requireClasses) issues.push(`must include at least ${policy.requireClasses} of: lowercase, uppercase, digit, symbol`);
  if (COMMON.has(pw.toLowerCase())) issues.push('is too common');
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && pw.toLowerCase().includes(local)) issues.push('must not contain your email name');
  return issues;
}
