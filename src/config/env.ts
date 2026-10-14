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
  DATA_ENCRYPTION_KEY: z.string().min(64),
  CORS_ORIGINS: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  METRICS_TOKEN: z.string().min(16).optional(),
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
  APP_VERSION: z.string().default('0.1.0'),
  GIT_SHA: z.string().default('dev'),
  /** Serve Swagger UI / Redoc / openapi.json. Default: on outside production. */
  SWAGGER: bool.optional(),
  /** Public base URL of the API, used for `servers` in the OpenAPI document. */
  APP_BASE_URL: z.string().url().optional(),
  /** Optional HTTP Basic gate in front of the docs (staging). Set both. */
  DOCS_BASIC_AUTH_USER: z.string().min(1).optional(),
  DOCS_BASIC_AUTH_PASS: z.string().min(8).optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`); // fail fast at boot
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.MAIL_DRIVER === 'console') throw new Error('Invalid environment configuration: MAIL_DRIVER=console is not allowed in production');
    if (env.CORS_ORIGINS.length === 0) throw new Error('Invalid environment configuration: CORS_ORIGINS required in production');
    if (env.SCAN_DRIVER === 'stub') throw new Error('Invalid environment configuration: SCAN_DRIVER=stub is not allowed in production');
  }
  if (!!env.DOCS_BASIC_AUTH_USER !== !!env.DOCS_BASIC_AUTH_PASS) {
    throw new Error('Invalid environment configuration: DOCS_BASIC_AUTH_USER and DOCS_BASIC_AUTH_PASS must be set together');
  }
  if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
    throw new Error('Invalid environment configuration: S3_BUCKET is required when STORAGE_DRIVER=s3');
  }
  return env;
}
