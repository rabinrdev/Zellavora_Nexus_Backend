import { RateLimiterMemory, RateLimiterPostgres, type RateLimiterAbstract } from 'rate-limiter-flexible';
import type { Pool } from 'pg';
import { AppError } from './errors.js';

export interface BucketConfig {
  points: number;
  durationSeconds: number;
}

export const BUCKETS = {
  default: { points: 300, durationSeconds: 60 },
  auth: { points: 10, durationSeconds: 60 }, // login / reset / register
  mfa: { points: 8, durationSeconds: 60 },
  invitation: { points: 20, durationSeconds: 60 },
  apikey: { points: 20, durationSeconds: 60 },
  search: { points: 60, durationSeconds: 60 },
} satisfies Record<string, BucketConfig>;
export type BucketName = keyof typeof BUCKETS;

/** Bucket overrides from the environment (local/e2e only; production rejects them at boot). */
export function bucketOverrides(env: { RATE_LIMIT_AUTH_POINTS?: number }): Partial<Record<BucketName, BucketConfig>> {
  return env.RATE_LIMIT_AUTH_POINTS ? { auth: { points: env.RATE_LIMIT_AUTH_POINTS, durationSeconds: 60 } } : {};
}

export interface RateLimitStore {
  /** Shared store: counters are visible to every API instance. Requires the `rate_limits` table. */
  pool: Pool;
  tableName?: string;
}

export class RateLimiter {
  private readonly limiters = new Map<string, RateLimiterAbstract>();
  constructor(
    private readonly overrides: Partial<Record<BucketName, BucketConfig>> = {},
    private readonly store?: RateLimitStore,
  ) {}

  private get(bucket: BucketName): RateLimiterAbstract {
    let l = this.limiters.get(bucket);
    if (!l) {
      const cfg = this.overrides[bucket] ?? BUCKETS[bucket];
      const memory = new RateLimiterMemory({ points: cfg.points, duration: cfg.durationSeconds, keyPrefix: bucket });
      l = this.store
        ? new RateLimiterPostgres({
            storeClient: this.store.pool, storeType: 'pool', tableName: this.store.tableName ?? 'rate_limits', tableCreated: true,
            points: cfg.points, duration: cfg.durationSeconds, keyPrefix: bucket,
            insuranceLimiter: memory, // a database hiccup must not take the API down: fall back to per-instance limiting
          })
        : memory;
      this.limiters.set(bucket, l);
    }
    return l;
  }

  /** Consumes one point per key (ip / account / org). Throws RATE_LIMITED carrying retryAfter seconds. */
  async consume(bucket: BucketName, ...keys: (string | null | undefined)[]): Promise<void> {
    for (const key of keys) {
      if (!key) continue;
      try {
        await this.get(bucket).consume(key);
      } catch (r) {
        const ms = (r as { msBeforeNext?: number }).msBeforeNext;
        if (ms === undefined) throw r; // a real error, not a limit hit
        const err = new AppError('RATE_LIMITED', 'Too many requests');
        (err as AppError & { retryAfter?: number }).retryAfter = Math.max(1, Math.ceil(ms / 1000));
        throw err;
      }
    }
  }
}
