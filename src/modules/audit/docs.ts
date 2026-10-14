import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const auditEvent = rowOf('audit_events', {
  describe: {
    actorId: 'User that performed the action; `null` for system actions.', actorType: '`user`, `api_key`, `system` or `signed_link`.',
    action: 'Machine action name, e.g. `invoice.sent`.', resourceType: 'Type of the affected resource.', resourceId: 'Id of the affected resource.',
    outcome: '`success`, `failure` or `denied`.', correlationId: 'The `requestId` of the request that caused the event.',
    metadata: 'Action-specific details (secrets are scrubbed).',
  },
});
const securityEvent = rowOf('security_events', {
  describe: { event: 'Event name, e.g. `login`, `lockout`, `permission_denied`.', outcome: '`success`, `failure` or `denied`.', metadata: 'Event details (secrets are scrubbed).' },
});

documentRoutes({
  listAuditEvents: {
    response: auditEvent, responseName: 'AuditEvent',
    list: { sortable: ['occurred_at', 'action'], filterable: [], defaultSort: '-occurred_at', searchable: false },
    description: 'Searches the append-only audit trail of the organization. Extra filters: `actorId`, `action` (prefix match), `resourceType`, `resourceId`, `outcome`, `from`, `to` (ISO-8601).',
  },
  getAuditEventById: { response: auditEvent, responseName: 'AuditEvent', description: 'One audit event.' },
  exportAuditEvents: {
    successStatus: 202, asyncJob: true,
    response: z.object({ id: uuid.describe('Export id; poll `getExportById`.'), kind: z.literal('audit').describe('Export kind.'), format: z.string().describe('`csv` or `json`.'), status: z.string().describe('`pending`.') }),
    description: 'Queues an export of audit events (max 100 000 rows). The export itself is audited as `audit.exported`.',
  },
  listSecurityEvents: {
    response: securityEvent, responseName: 'SecurityEvent',
    list: { sortable: ['occurred_at'], filterable: ['outcome'], defaultSort: '-occurred_at', searchable: false },
    description: 'Sign-ins, lockouts, MFA events and permission denials of the organization. Extra filter: `event`.',
  },
  getAuditRetentionPolicy: {
    response: z.object({
      retentionDays: z.number().int().describe('Days audit events are kept.'), legalHold: z.boolean().describe('While `true`, audit events are never purged.'),
      isDefault: z.boolean().optional().describe('`true` when no policy was stored and the default (365 days) applies.'),
      organizationId: uuid.optional().describe('Owning organization (stored policies only).'),
    }).loose(),
    responseName: 'AuditRetentionPolicy', description: 'The audit retention policy; defaults to 365 days with no legal hold.',
  },
  replaceAuditRetentionPolicy: {
    successStatus: 200,
    response: z.object({ retentionDays: z.number().int().describe('Days kept (30-3650).'), legalHold: z.boolean().describe('Legal hold flag.') }),
    description: 'Sets the audit retention window (30-3650 days) and legal hold.',
  },
});
