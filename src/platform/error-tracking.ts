import { randomUUID } from 'node:crypto';
import { deepScrub } from './redact.js';

export interface ErrorContext {
  requestId?: string;
  route?: string;
  method?: string;
  organizationId?: string | null;
  userId?: string | null;
  extra?: Record<string, unknown>;
}

/** Sentry-compatible tracking interface (F-161). Implementations must never receive request bodies or secrets. */
export interface ErrorTracker {
  capture(err: unknown, ctx?: ErrorContext): void;
}

export class NoopErrorTracker implements ErrorTracker {
  capture(): void {}
}

/** Test/dev tracker: keeps events in memory. */
export class MemoryErrorTracker implements ErrorTracker {
  readonly events: { message: string; name: string; ctx: ErrorContext }[] = [];
  capture(err: unknown, ctx: ErrorContext = {}): void {
    const e = err as Error;
    this.events.push({ message: e?.message ?? String(err), name: e?.name ?? 'Error', ctx });
  }
}

/** Parses `https://<key>@<host>/<projectId>` (Sentry DSN format). */
export function parseDsn(dsn: string): { url: string; key: string } {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\//, '');
  if (!u.username || !projectId) throw new Error('Invalid error-tracking DSN');
  return { url: `${u.protocol}//${u.host}/api/${projectId}/store/`, key: u.username };
}

/** Posts events to any Sentry-compatible store endpoint. Fire-and-forget; failures never affect requests. */
export class HttpErrorTracker implements ErrorTracker {
  private readonly target: { url: string; key: string };
  constructor(dsn: string, private readonly opts: { environment: string; release: string; fetchFn?: typeof fetch }) {
    this.target = parseDsn(dsn);
  }
  capture(err: unknown, ctx: ErrorContext = {}): void {
    const e = err as Error;
    const event = {
      event_id: randomUUID().replace(/-/g, ''),
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: 'error',
      environment: this.opts.environment,
      release: this.opts.release,
      exception: { values: [{ type: e?.name ?? 'Error', value: e?.message ?? String(err), stacktrace: { frames: [] } }] },
      tags: { request_id: ctx.requestId, route: ctx.route, method: ctx.method },
      user: { id: ctx.userId ?? undefined },
      extra: deepScrub({ organizationId: ctx.organizationId, ...ctx.extra }),
    };
    void (this.opts.fetchFn ?? fetch)(this.target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_client=nexus-api/1, sentry_key=${this.target.key}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }
}
