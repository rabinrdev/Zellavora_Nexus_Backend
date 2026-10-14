import type { Knex } from 'knex';
import { newId } from './crypto.js';
import { withPlatformScope, type Trx } from './scope.js';

export interface DomainEvent {
  id: string;
  type: string;
  organizationId: string | null;
  payload: Record<string, unknown>;
  correlationId?: string;
}
export type EventHandler = (e: DomainEvent) => Promise<void>;

/**
 * Typed-ish domain event bus with a transactional outbox: `emit(trx, …)` stores the event in the same
 * transaction as the business change; `dispatchPending()` delivers it to subscribers exactly-once-marked.
 */
export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  constructor(private readonly db: Knex) {}

  on(type: string, handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async emit(
    trx: Trx,
    type: string,
    organizationId: string | null,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    await trx('outbox_events').insert({
      id: newId(),
      organization_id: organizationId,
      type,
      payload: JSON.stringify(payload),
      correlation_id: correlationId ?? null,
    });
  }

  /** Delivers undispatched events in order. Failed handlers leave the event pending for retry. */
  async dispatchPending(limit = 100): Promise<number> {
    return withPlatformScope(this.db, 'outbox-dispatch', async (trx) => {
      const rows = await trx('outbox_events')
        .whereNull('dispatched_at')
        .orderBy('created_at')
        .limit(limit)
        .forUpdate()
        .skipLocked();
      let done = 0;
      for (const r of rows) {
        const ev: DomainEvent = {
          id: r.id,
          type: r.type,
          organizationId: r.organization_id,
          payload: r.payload,
          correlationId: r.correlation_id ?? undefined,
        };
        try {
          for (const h of [...(this.handlers.get(ev.type) ?? []), ...(this.handlers.get('*') ?? [])]) await h(ev);
          await trx('outbox_events').where({ id: r.id }).update({ dispatched_at: trx.fn.now() });
          done++;
        } catch {
          break; // preserve ordering; retried on next tick
        }
      }
      return done;
    });
  }
}
