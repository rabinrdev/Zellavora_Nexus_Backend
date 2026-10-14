import { createDb } from './db/knex.js';
import type { Env } from './config/env.js';
import { createLogger } from './platform/logger.js';
import { EnvKeyProvider } from './platform/crypto.js';
import { SmtpMailProvider, MemoryMailProvider, type MailProvider } from './platform/mail.js';
import { LocalDiskStorage, type StorageProvider } from './platform/storage.js';
import { S3Storage } from './platform/storage-s3.js';
import { ClamdScanner, StubScanner, setScanner } from './platform/files.js';
import { HttpErrorTracker, NoopErrorTracker, type ErrorTracker } from './platform/error-tracking.js';
import { EventBus } from './platform/events.js';
import { InlineJobQueue, PgBossJobQueue, type JobQueue } from './platform/jobs.js';
import { seedFlags } from './platform/flags.js';
import { syncCatalogAndSystemRoles } from './modules/iam/system-roles.js';
import type { Services } from './platform/types.js';
import { registerJobs } from './platform/job-handlers.js';
import './modules/index.js'; // registers all routes into the route registry

export interface Overrides {
  fetch?: typeof fetch;
  resolver?: (host: string) => Promise<string[]>;
  mail?: MailProvider;
  storage?: StorageProvider;
  jobs?: JobQueue;
  tracker?: ErrorTracker;
}

export async function buildServices(env: Env, overrides: Overrides = {}): Promise<Services> {
  const db = createDb(env.DATABASE_URL, env.DB_POOL_MAX);
  const log = createLogger(env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL);
  const mail =
    overrides.mail ??
    (env.MAIL_DRIVER === 'smtp' && env.SMTP_URL ? new SmtpMailProvider(env.SMTP_URL, env.MAIL_FROM) : new MemoryMailProvider());
  const storage =
    overrides.storage ??
    (env.STORAGE_DRIVER === 's3'
      ? new S3Storage({
          bucket: env.S3_BUCKET!, region: env.S3_REGION, endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY, prefix: env.S3_PREFIX,
        })
      : new LocalDiskStorage(env.STORAGE_DIR));
  setScanner(env.SCAN_DRIVER === 'clamd' ? new ClamdScanner(env.CLAMD_HOST, env.CLAMD_PORT) : new StubScanner());
  const tracker =
    overrides.tracker ??
    (env.ERROR_TRACKING_DSN
      ? new HttpErrorTracker(env.ERROR_TRACKING_DSN, { environment: env.NODE_ENV, release: env.APP_VERSION, fetchFn: overrides.fetch })
      : new NoopErrorTracker());
  const jobs =
    overrides.jobs ??
    (env.JOBS_DRIVER === 'inline' || env.NODE_ENV === 'test'
      ? new InlineJobQueue(db)
      : new PgBossJobQueue(env.MIGRATOR_DATABASE_URL ?? env.DATABASE_URL, db, { poolMax: env.JOBS_DB_POOL_MAX, onError: (e) => log.error({ err: e.message }, 'job queue error') }));
  const svc: Services = {
    env, db, log, keys: new EnvKeyProvider(env.DATA_ENCRYPTION_KEY), mail, storage,
    events: new EventBus(db), jobs, tracker, now: () => new Date(), fetch: overrides.fetch, resolver: overrides.resolver,
  };
  const flagsOn = (env.MODULE_FLAGS_DEFAULT ?? (env.NODE_ENV === 'production' ? 'off' : 'on')) === 'on';
  registerJobs(svc);
  await syncCatalogAndSystemRoles(db);
  const { withPlatformScope } = await import('./platform/scope.js');
  await withPlatformScope(db, 'flag-seed', (t) => seedFlags(t, flagsOn));
  return svc;
}
