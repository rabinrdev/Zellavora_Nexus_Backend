import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().url(), // runtime connection: non-owner role `nexus_app`
  MIGRATOR_DATABASE_URL: z.string().url().optional(), // migrations / pg-boss schema: owner role
  NEXUS_APP_DB_PASSWORD: z.string().min(8).default('nexus_app_dev_pw'),
  JWT_SECRET: z.string().min(32),
  /** "1:<64hex>,2:<64hex>" for rotation, or a single 64-hex key. */
  DATA_ENCRYPTION_KEY: z.string().regex(/^(\d+:)?[0-9a-fA-F]{64}(,\d+:[0-9a-fA-F]{64})*$/, 'must be one 64-hex-char key or "1:<64hex>,2:<64hex>"'),
  CORS_ORIGINS: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Shared secret for the scheduler endpoint (Vercel Cron sends it as a Bearer token). */
  CRON_SECRET: z.string().min(16).optional(),
  MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Zellavora Nexus <no-reply@example.test>'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PREFIX: z.string().default(''),
  SCAN_DRIVER: z.enum(['stub', 'clamd']).default('stub'),
  /** Production only: allow SCAN_DRIVER=stub (uploads are NOT malware-scanned). For hosts that cannot reach a clamd server. */
  ALLOW_UNSCANNED_UPLOADS: bool.default(false),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().default(3310),
  ERROR_TRACKING_DSN: z.string().url().optional(),
  STORAGE_DIR: z.string().default('./.storage'),
  STORAGE_QUOTA_BYTES: z.coerce.number().int().default(1024 * 1024 * 1024),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(10 * 1024 * 1024),
  MODULE_FLAGS_DEFAULT: z.enum(['on', 'off']).optional(),
  OUTBOUND_REQUIRE_HTTPS: bool.optional(),
  /** Connection budget. Managed poolers cap total clients (Supabase session mode: 15): keep db + jobs well below it. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  JOBS_DB_POOL_MAX: z.coerce.number().int().min(2).max(20).default(4),
  JOBS_DRIVER: z.enum(['pgboss', 'inline']).default('pgboss'),
  /** postgres = shared counters across instances (default in production); memory = per instance. */
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).optional(),
  /** Local/e2e only: raises the per-minute `auth` bucket (default 10). Rejected in production. */
  RATE_LIMIT_AUTH_POINTS: z.coerce.number().int().min(1).optional(),
  APP_VERSION: z.string().default('0.1.0'),
  GIT_SHA: z.string().default('dev'),
  /** Serve Swagger UI / Redoc / openapi.json. Default: on outside production. */
  SWAGGER: bool.optional(),
  /** Public base URL of the API, used for `servers` in the OpenAPI document. */
  APP_BASE_URL: z.string().url().optional(),
  /** Optional HTTP Basic gate in front of the docs (staging). Set both. */
  DOCS_BASIC_AUTH_USER: z.string().min(1).optional(),
  DOCS_BASIC_AUTH_PASS: z.string().min(8).optional(),
  /** Supabase project URL and publishable (anon-equivalent) key. Optional; only needed when the Supabase client is used. */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  /** Privileged Supabase key (bypasses RLS). Server-only; never expose to clients. */
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof schema>;

export class EnvConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration: ${problems.join('; ')}`);
    this.name = 'EnvConfigError';
  }
}

/**
 * Every configuration problem at once (names and rules only, never values), so one deploy fixes them all.
 * Empty array = valid. Used by `loadEnv` and by the serverless handler's boot-independent config check.
 */
export function collectEnvProblems(source: NodeJS.ProcessEnv = process.env): string[] {
  const parsed = schema.safeParse(source);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  const env = parsed.data;
  const problems: string[] = [];
  if (env.NODE_ENV === 'production') {
    if (env.MAIL_DRIVER === 'console') problems.push('MAIL_DRIVER=console is not allowed in production (set MAIL_DRIVER=smtp and SMTP_URL)');
    if (env.MAIL_DRIVER === 'smtp' && !env.SMTP_URL) problems.push('SMTP_URL is required when MAIL_DRIVER=smtp');
    if (env.CORS_ORIGINS.length === 0) problems.push('CORS_ORIGINS required in production');
    if (env.RATE_LIMIT_AUTH_POINTS !== undefined) problems.push('RATE_LIMIT_AUTH_POINTS is not allowed in production');
    if (env.SCAN_DRIVER === 'stub' && !env.ALLOW_UNSCANNED_UPLOADS) {
      problems.push('SCAN_DRIVER=stub is not allowed in production (set SCAN_DRIVER=clamd, or ALLOW_UNSCANNED_UPLOADS=true to accept unscanned uploads)');
    }
  }
  if (!!env.DOCS_BASIC_AUTH_USER !== !!env.DOCS_BASIC_AUTH_PASS) {
    problems.push('DOCS_BASIC_AUTH_USER and DOCS_BASIC_AUTH_PASS must be set together');
  }
  if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) problems.push('S3_BUCKET is required when STORAGE_DRIVER=s3');
  return problems;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const problems = collectEnvProblems(source);
  if (problems.length > 0) throw new EnvConfigError(problems); // fail fast at boot
  return schema.parse(source);
}
