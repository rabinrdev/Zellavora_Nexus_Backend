import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { rowToApi } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant } from '../../platform/scope.js';
import { isFlagEnabled } from '../../platform/flags.js';
import type { DomainEvent } from '../../platform/events.js';
import type { Services } from '../../platform/types.js';

const M = 'notifications';
const FLAG = 'module.notifications';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const CHANNELS = ['in_app', 'email'] as const;

interface EventRule {
  recipients(e: DomainEvent, trx: import('../../platform/scope.js').Trx): Promise<string[]>;
  subject: string;
  body: string;
  link?: (e: DomainEvent) => string;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : v ? [String(v)] : []);

export const EVENT_RULES: Record<string, EventRule> = {
  'task.assigned': {
    recipients: async (e) => arr(e.payload.assigneeId), subject: 'You were assigned a task: {{title}}',
    body: 'A task has been assigned to you: {{title}}.', link: (e) => `/tasks/${e.payload.taskId}`,
  },
  'approval.requested': {
    recipients: async (e) => arr(e.payload.approverIds), subject: 'Approval needed: {{title}}',
    body: 'Your decision is needed on "{{title}}".', link: (e) => `/approvals/${e.payload.requestId}`,
  },
  'approval.approved': { recipients: async (e) => arr(e.payload.requesterId), subject: 'Approved: {{title}}', body: 'Your request "{{title}}" was approved.', link: (e) => `/approvals/${e.payload.requestId}` },
  'approval.rejected': { recipients: async (e) => arr(e.payload.requesterId), subject: 'Rejected: {{title}}', body: 'Your request "{{title}}" was rejected.', link: (e) => `/approvals/${e.payload.requestId}` },
  'approval.changes_requested': { recipients: async (e) => arr(e.payload.requesterId), subject: 'Changes requested: {{title}}', body: 'Changes were requested on "{{title}}".', link: (e) => `/approvals/${e.payload.requestId}` },
  'approval.overdue': { recipients: async (e) => [...arr(e.payload.requesterId), ...arr(e.payload.escalatedTo)], subject: 'Approval overdue: {{title}}', body: 'The approval "{{title}}" is overdue.', link: (e) => `/approvals/${e.payload.requestId}` },
  'approval.reminder': { recipients: async (e) => arr(e.payload.approverIds), subject: 'Reminder: {{title}}', body: 'Reminder: "{{title}}" is due within 24 hours.', link: (e) => `/approvals/${e.payload.requestId}` },
  'timesheet.submitted': {
    async recipients(e, trx) {
      const rows = await trx('team_members as mine').join('team_members as tm', 'tm.team_id', 'mine.team_id')
        .where({ 'tm.user_id': e.payload.userId as string, 'mine.is_leader': true }).distinct('mine.user_id');
      return rows.map((r) => r.user_id as string);
    },
    subject: 'Timesheet submitted for {{periodStart}}', body: 'A timesheet for the week of {{periodStart}} awaits your review.', link: (e) => `/timesheets/${e.payload.timesheetId}`,
  },
  'timesheet.approved': { recipients: async (e) => arr(e.payload.userId), subject: 'Timesheet approved', body: 'Your timesheet for {{periodStart}} was approved.', link: (e) => `/timesheets/${e.payload.timesheetId}` },
  'timesheet.rejected': { recipients: async (e) => arr(e.payload.userId), subject: 'Timesheet rejected', body: 'Your timesheet for {{periodStart}} was rejected.', link: (e) => `/timesheets/${e.payload.timesheetId}` },
  'document.expiring': { recipients: async (e) => arr(e.payload.ownerId), subject: 'Document expiring: {{title}}', body: 'The document "{{title}}" expires on {{expiresOn}}.', link: (e) => `/documents/${e.payload.documentId}` },
  'followup.reminder': { recipients: async (e) => arr(e.payload.assigneeId), subject: 'Follow-up due: {{title}}', body: 'A follow-up is due soon: {{title}}.', link: (e) => `/follow-ups/${e.payload.followUpId}` },
  'invoice.overdue': { recipients: async (e) => arr(e.payload.createdBy), subject: 'Invoice {{number}} is overdue', body: 'Invoice {{number}} is now overdue.', link: (e) => `/invoices/${e.payload.invoiceId}` },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Auto-escaping `{{var}}` renderer. No expressions, loops or code: unknown variables render empty. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>, html = false): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]{1,60})\s*\}\}/g, (_m, key: string) => {
    let v: unknown = vars;
    for (const part of key.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    const s = v === undefined || v === null || typeof v === 'object' ? '' : String(v);
    return html ? esc(s) : s;
  });
}

const PAYLOAD_VARS = ['title', 'periodStart', 'number', 'taskId', 'requestId', 'expiresOn'];
const safePayload = (p: Record<string, unknown>) => Object.fromEntries(PAYLOAD_VARS.filter((k) => k in p).map((k) => [k, p[k]])); // minimal, non-sensitive

async function prefEnabled(trx: import('../../platform/scope.js').Trx, orgId: string, userId: string, eventType: string, channel: string): Promise<boolean> {
  const p = await trx('notification_preferences').where({ organization_id: orgId, user_id: userId, event_type: eventType, channel }).first();
  return p ? p.enabled : true;
}

export async function deliverEvent(svc: Services, e: DomainEvent): Promise<void> {
  const rule = EVENT_RULES[e.type];
  if (!rule || !e.organizationId) return;
  const orgId = e.organizationId;
  if (!(await isFlagEnabled(svc.db, FLAG, { organizationId: orgId }))) return;
  await withTenant(svc.db, { organizationId: orgId, userId: null }, async (trx) => {
    const recipients = [...new Set(await rule.recipients(e, trx))];
    const vars = safePayload(e.payload);
    for (const uid of recipients) {
      const user = await svc.db('users').where({ id: uid, status: 'active' }).first('email', 'locale');
      const m = await trx('organization_memberships').where({ organization_id: orgId, user_id: uid, status: 'active' }).first();
      if (!user || !m) continue;
      const wantInApp = await prefEnabled(trx, orgId, uid, e.type, 'in_app');
      const wantEmail = await prefEnabled(trx, orgId, uid, e.type, 'email');
      if (!wantInApp && !wantEmail) continue;
      const override = async (channel: string) => trx('notification_templates')
        .where({ organization_id: orgId, event_type: e.type, channel, active: true }).whereIn('locale', [user.locale, 'en']).orderBy('version', 'desc').first();
      const inTpl = await override('in_app');
      const emTpl = await override('email');
      const title = renderTemplate(inTpl?.subject ?? rule.subject, vars);
      const body = renderTemplate(inTpl?.body ?? rule.body, vars);
      const id = newId();
      const ins = await trx('notifications').insert({
        id, organization_id: orgId, recipient_id: uid, type: e.type, title, body, link: rule.link?.(e) ?? null,
        payload: JSON.stringify(vars), dedupe_key: `${e.id}`, in_app: wantInApp,
      }).onConflict(trx.raw('(organization_id, recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL') as never).ignore().returning('id');
      if (ins.length === 0) continue; // duplicate event delivery
      if (wantEmail) {
        await svc.jobs.enqueue('notifications', {
          organizationId: orgId, notificationId: id, to: user.email,
          subject: renderTemplate(emTpl?.subject ?? rule.subject, vars), text: renderTemplate(emTpl?.body ?? rule.body, vars),
        });
      }
    }
  });
}

jobRegistrars.push((svc) => {
  for (const type of Object.keys(EVENT_RULES)) svc.events.on(type, (e) => deliverEvent(svc, e));
  svc.jobs.work('notifications', async (d) => {
    const orgId = d.organizationId as string;
    try {
      await svc.mail.send({ to: d.to as string, subject: d.subject as string, text: d.text as string });
      await withPlatformScope(svc.db, 'delivery-log', (t) => t('delivery_attempts').insert({
        id: newId(), organization_id: orgId, notification_id: d.notificationId as string, channel: 'email', status: 'sent', attempt: 1, recipient: d.to as string,
      }));
    } catch (err) {
      await withPlatformScope(svc.db, 'delivery-log', (t) => t('delivery_attempts').insert({
        id: newId(), organization_id: orgId, notification_id: d.notificationId as string, channel: 'email', status: 'failed', attempt: 1,
        recipient: d.to as string, error_summary: (err as Error).message.slice(0, 300),
      }));
      throw err; // bounded retry with backoff by the queue
    }
  });
});

defineRoute({
  method: 'get', path: '/notifications', module: M, moduleFlag: FLAG, summary: 'My notifications',
  access: { permission: 'notifications:read' }, query: listQuerySchema.extend({ unread: z.enum(['true', 'false']).optional() }), response: obj,
  async handler(c) {
    const q = c.query as { unread?: string } & ListQuery;
    const qb = c.trx('notifications').where({ organization_id: c.orgId(), recipient_id: c.auth!.userId, in_app: true });
    if (q.unread === 'true') qb.whereNull('read_at');
    const page = await paginate(qb, q, { sortable: { created_at: 'created_at' }, defaultSort: '-created_at' });
    return { data: page.data.map((r) => rowToApi(r, ['dedupe_key', 'in_app'])), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/notifications/unread-count', module: M, moduleFlag: FLAG, summary: 'Unread notification count',
  access: { permission: 'notifications:read' }, response: obj,
  async handler(c) {
    const r = await c.trx('notifications').where({ organization_id: c.orgId(), recipient_id: c.auth!.userId, in_app: true }).whereNull('read_at').count({ c: '*' }).first();
    return { data: { unread: Number((r as { c: string }).c) } };
  },
});

defineRoute({
  method: 'post', path: '/notifications/read-all', module: M, moduleFlag: FLAG, summary: 'Mark all as read',
  access: { permission: 'notifications:read' }, response: obj,
  async handler(c) {
    const n = await c.trx('notifications').where({ organization_id: c.orgId(), recipient_id: c.auth!.userId }).whereNull('read_at').update({ read_at: c.svc.now() });
    return { status: 200, data: { updated: n } };
  },
});

defineRoute({
  method: 'post', path: '/notifications/:id/read', module: M, moduleFlag: FLAG, summary: 'Mark one as read',
  access: { permission: 'notifications:read' }, params: z.object({ id: uuid }), response: obj,
  async handler(c) {
    const n = await c.trx('notifications').where({ id: c.params.id, organization_id: c.orgId(), recipient_id: c.auth!.userId }).update({ read_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Notification not found');
    return { status: 200, data: { id: c.params.id, read: true } };
  },
});

defineRoute({
  method: 'get', path: '/notification-preferences', module: M, moduleFlag: FLAG, summary: 'My notification preferences',
  access: { permission: 'notifications:read' }, response: obj,
  async handler(c) {
    const rows = await c.trx('notification_preferences').where({ organization_id: c.orgId(), user_id: c.auth!.userId });
    const set = new Map(rows.map((r) => [`${r.event_type}:${r.channel}`, r.enabled as boolean]));
    return { data: Object.keys(EVENT_RULES).flatMap((eventType) => CHANNELS.map((channel) => ({ eventType, channel, enabled: set.get(`${eventType}:${channel}`) ?? true }))) };
  },
});

defineRoute({
  method: 'put', path: '/notification-preferences', module: M, moduleFlag: FLAG, summary: 'Update my notification preferences',
  access: { permission: 'notifications:read' },
  body: z.object({ preferences: z.array(z.object({ eventType: z.string().max(60), channel: z.enum(CHANNELS), enabled: z.boolean() })).max(100) }), response: obj,
  async handler(c) {
    for (const p of c.body.preferences) {
      if (!EVENT_RULES[p.eventType]) throw new AppError('VALIDATION_FAILED', 'Unknown event type', [{ field: 'preferences', issue: p.eventType }]);
      await c.trx('notification_preferences').insert({
        id: newId(), organization_id: c.orgId(), user_id: c.auth!.userId, event_type: p.eventType, channel: p.channel, enabled: p.enabled,
      }).onConflict(['organization_id', 'user_id', 'event_type', 'channel']).merge({ enabled: p.enabled });
    }
    return { status: 200, data: { updated: c.body.preferences.length } };
  },
});

const tplBody = z.object({
  eventType: z.string().max(60), channel: z.enum(CHANNELS), locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en'),
  subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000),
});

defineRoute({
  method: 'put', path: '/notification-templates', module: M, moduleFlag: FLAG, summary: 'Create a new template version (org override)',
  access: { permission: 'notifications:manage' }, body: tplBody, response: obj,
  audit: { action: 'notification_template.versioned', resourceType: 'notification_template' },
  async handler(c) {
    if (!EVENT_RULES[c.body.eventType]) throw new AppError('VALIDATION_FAILED', 'Unknown event type', [{ field: 'eventType', issue: 'unknown' }]);
    const last = await c.trx('notification_templates').where({ organization_id: c.orgId(), event_type: c.body.eventType, channel: c.body.channel, locale: c.body.locale }).max({ v: 'version' }).first();
    const version = Number((last as { v: number | null }).v ?? 0) + 1;
    await c.trx('notification_templates').where({ organization_id: c.orgId(), event_type: c.body.eventType, channel: c.body.channel, locale: c.body.locale }).update({ active: false });
    const id = newId();
    await c.trx('notification_templates').insert({
      id, organization_id: c.orgId(), event_type: c.body.eventType, channel: c.body.channel, locale: c.body.locale,
      subject: c.body.subject, body: c.body.body, version, created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    return { status: 201, data: { id, version } };
  },
});

defineRoute({
  method: 'get', path: '/notification-templates', module: M, moduleFlag: FLAG, summary: 'Templates (defaults + overrides)',
  access: { permission: 'notifications:manage' }, response: obj,
  async handler(c) {
    const overrides = await c.trx('notification_templates').where({ organization_id: c.orgId(), active: true });
    return {
      data: {
        defaults: Object.entries(EVENT_RULES).map(([eventType, r]) => ({ eventType, subject: r.subject, body: r.body })),
        overrides: overrides.map((r) => rowToApi(r)),
      },
    };
  },
});

defineRoute({
  method: 'post', path: '/notification-templates/preview', module: M, moduleFlag: FLAG, summary: 'Preview a template with sample data',
  access: { permission: 'notifications:manage' },
  body: z.object({ subject: z.string().max(200), body: z.string().max(5000), sample: z.record(z.string(), z.unknown()).default({}) }), response: obj,
  async handler(c) {
    return { status: 200, data: { subject: renderTemplate(c.body.subject, c.body.sample), text: renderTemplate(c.body.body, c.body.sample), html: renderTemplate(c.body.body, c.body.sample, true) } };
  },
});

defineRoute({
  method: 'get', path: '/notifications/delivery-log', module: M, moduleFlag: FLAG, summary: 'Delivery attempts and failures',
  access: { permission: 'notifications:manage' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('delivery_attempts').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { created_at: 'created_at' }, filterable: { status: 'status', channel: 'channel' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});
