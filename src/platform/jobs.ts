import { PgBoss } from 'pg-boss';
import type { Knex } from 'knex';
import { newId } from './crypto.js';
import { withPlatformScope } from './scope.js';

export const QUEUES = [
  'mail', 'notifications', 'webhooks', 'reports', 'imports', 'exports', 'retention', 'reminders', 'scan',
  'provisioning', 'billing',
] as const;
export type QueueName = (typeof QUEUES)[number];
export type JobHandler = (data: Record<string, unknown>) => Promise<void>;

export interface JobQueue {
  enqueue(queue: QueueName, data: Record<string, unknown>, opts?: { startAfterSeconds?: number }): Promise<void>;
  work(queue: QueueName, handler: JobHandler): void;
  schedule(queue: QueueName, cron: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const MAX_ATTEMPTS = 5;

async function record(db: Knex, queue: string, status: string, attempts: number, error?: string) {
  await withPlatformScope(db, 'job-run-record', (t) =>
    t('job_runs').insert({
      id: newId(), queue, status, attempts, finished_at: new Date(),
      error_summary: error ? error.slice(0, 500) : null, // summaries only: never payloads or secrets
    }),
  );
}

/** Test/dev queue: runs handlers in-process with bounded retries (no backoff delay under test). */
export class InlineJobQueue implements JobQueue {
  private readonly handlers = new Map<QueueName, JobHandler[]>();
  readonly deadLetter: { queue: string; data: Record<string, unknown> }[] = [];
  constructor(private readonly db: Knex) {}
  work(queue: QueueName, handler: JobHandler) {
    this.handlers.set(queue, [...(this.handlers.get(queue) ?? []), handler]);
  }
  async enqueue(queue: QueueName, data: Record<string, unknown>) {
    const list = this.handlers.get(queue);
    if (!list || list.length === 0) return;
    const h: JobHandler = async (d) => { for (const fn of list) await fn(d); };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await h(data);
        await record(this.db, queue, 'completed', attempt);
        return;
      } catch (e) {
        if (attempt === MAX_ATTEMPTS) {
          this.deadLetter.push({ queue, data });
          await record(this.db, queue, 'dead_letter', attempt, (e as Error).message);
        }
      }
    }
  }
  async schedule() {}
  async start() {}
  async stop() {}
}

/** Production queue: pg-boss (Postgres-backed) with exponential backoff and a dead-letter queue per queue. */
export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly handlers = new Map<QueueName, JobHandler[]>();
  private readonly bound = new Set<QueueName>();
  private started = false;
  constructor(connectionString: string, private readonly db: Knex, private readonly opts: { pollingIntervalSeconds?: number; poolMax?: number; onError?: (e: Error) => void } = {}) {
    this.boss = new PgBoss({ connectionString, max: opts.poolMax ?? 4 });
    // an unhandled 'error' event would crash the process; connection hiccups must only be logged and retried
    this.boss.on('error', (e: Error) => opts.onError?.(e));
  }
  async start() {
    await this.boss.start();
    for (const q of QUEUES) {
      await this.boss.createQueue(`${q}.dlq`);
      await this.boss.createQueue(q, {
        retryLimit: MAX_ATTEMPTS, retryDelay: 5, retryBackoff: true, deadLetter: `${q}.dlq`,
      });
    }
    this.started = true;
    for (const q of this.handlers.keys()) this.bind(q);
  }
  private bind(queue: QueueName) {
    if (this.bound.has(queue)) return;
    this.bound.add(queue);
    const handler: JobHandler = async (d) => { for (const fn of this.handlers.get(queue) ?? []) await fn(d); };
    void this.boss.work<Record<string, unknown>>(queue, { pollingIntervalSeconds: this.opts.pollingIntervalSeconds ?? 2 }, async (jobs) => {
      for (const job of jobs) {
        try {
          await handler(job.data);
          await record(this.db, queue, 'completed', 1);
        } catch (e) {
          await record(this.db, queue, 'failed', 1, (e as Error).message);
          throw e; // lets pg-boss retry with backoff / dead-letter
        }
      }
    });
  }
  work(queue: QueueName, handler: JobHandler) {
    this.handlers.set(queue, [...(this.handlers.get(queue) ?? []), handler]);
    if (this.started) this.bind(queue);
  }
  async enqueue(queue: QueueName, data: Record<string, unknown>, opts?: { startAfterSeconds?: number }) {
    await this.boss.send(queue, data, opts?.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {});
  }
  async schedule(queue: QueueName, cron: string) {
    await this.boss.schedule(queue, cron);
  }
  async stop() {
    await this.boss.stop({ graceful: true });
  }
}
