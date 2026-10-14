const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|otp|mfa|recovery|card|cvv|ssn|hash/i;

export const REDACTED = '[REDACTED]';

/** Deep-scrubs secrets from arbitrary values before they reach logs, audit metadata or error bodies. */
export function deepScrub<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : deepScrub(v, depth + 1);
    }
    return out as T;
  }
  if (typeof value === 'string' && /^Bearer\s+\S+/i.test(value)) return REDACTED as unknown as T;
  return value;
}

export const LOG_REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
  '*.password', '*.newPassword', '*.currentPassword', '*.token', '*.refreshToken', '*.accessToken',
  '*.secret', '*.apiKey', '*.code', '*.mfaCode', '*.recoveryCode',
  'password', 'token', 'refreshToken', 'secret', 'apiKey',
];
