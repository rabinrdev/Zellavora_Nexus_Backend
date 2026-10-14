import type { Knex } from 'knex';
import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { KeyProvider } from './crypto.js';
import type { MailProvider } from './mail.js';
import type { StorageProvider } from './storage.js';
import type { EventBus } from './events.js';
import type { JobQueue } from './jobs.js';
import type { ErrorTracker } from './error-tracking.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  membershipId: string | null;
  permissions: ReadonlySet<string>;
  isPlatformAdmin: boolean;
  permissionVersion: number;
  realm: 'staff' | 'apikey' | 'support';
  apiKeyId?: string;
}

export interface Services {
  env: Env;
  db: Knex; // runtime connection (nexus_app, RLS enforced)
  log: Logger;
  keys: KeyProvider;
  mail: MailProvider;
  storage: StorageProvider;
  events: EventBus;
  jobs: JobQueue;
  now: () => Date;
  tracker: ErrorTracker;
  /** Outbound HTTP (webhooks). Replaceable in tests. */
  fetch?: typeof fetch;
  /** DNS resolver used by the SSRF guard. Replaceable in tests. */
  resolver?: (host: string) => Promise<string[]>;
}
