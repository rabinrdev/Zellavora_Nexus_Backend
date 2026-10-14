import { newId } from './crypto.js';
import { deepScrub } from './redact.js';
import type { Trx } from './scope.js';

export interface AuditInput {
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'success' | 'failure' | 'denied';
  metadata?: Record<string, unknown>;
}

export interface RequestMeta {
  organizationId: string | null;
  actorId: string | null;
  actorType?: string;
  correlationId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** Writes inside the caller's transaction: audit and business change commit or roll back together. */
export async function recordAudit(trx: Trx, meta: RequestMeta, input: AuditInput): Promise<void> {
  await trx('audit_events').insert({
    id: newId(),
    organization_id: meta.organizationId,
    actor_id: meta.actorId,
    actor_type: meta.actorType ?? 'user',
    action: input.action,
    resource_type: input.resourceType ?? null,
    resource_id: input.resourceId ?? null,
    outcome: input.outcome ?? 'success',
    correlation_id: meta.correlationId ?? null,
    ip: meta.ip ?? null,
    user_agent: meta.userAgent?.slice(0, 300) ?? null,
    metadata: JSON.stringify(deepScrub(input.metadata ?? {})),
  });
}

export async function recordSecurityEvent(
  trx: Trx,
  meta: RequestMeta & { userId?: string | null },
  event: string,
  outcome: 'success' | 'failure' | 'denied' = 'success',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await trx('security_events').insert({
    id: newId(),
    organization_id: meta.organizationId,
    user_id: meta.userId ?? meta.actorId,
    event,
    outcome,
    ip: meta.ip ?? null,
    user_agent: meta.userAgent?.slice(0, 300) ?? null,
    correlation_id: meta.correlationId ?? null,
    metadata: JSON.stringify(deepScrub(metadata)),
  });
}
