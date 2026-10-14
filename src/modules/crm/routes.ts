import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import type { Request } from 'express';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId, randomToken, sha256 } from '../../platform/crypto.js';
import { crudResource, rowToApi, mapDbError } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { hashPassword, verifyPassword, dummyVerify, passwordProblems, DEFAULT_PASSWORD_POLICY } from '../../platform/auth/password.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { isFlagEnabled } from '../../platform/flags.js';
import { fileDto } from '../../platform/files.js';
import type { Services } from '../../platform/types.js';

const M = 'crm';
const FLAG = 'module.crm';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/).transform((p) => p.replace(/[^\d+]/g, ''));

const logActivity = (trx: Trx, orgId: string, customerId: string, kind: string, summary: string, actorId: string | null, ref?: { type: string; id: string }) =>
  trx('client_activities').insert({
    id: newId(), organization_id: orgId, customer_id: customerId, kind, summary, actor_id: actorId, ref_type: ref?.type ?? null, ref_id: ref?.id ?? null,
  });

// ---- leads / contacts / enquiries / follow-ups ------------------------------------------------------------------------

crudResource({
  module: M, moduleFlag: FLAG, path: '/leads', table: 'leads', resource: 'leads', softDelete: true, rowVersion: true,
  create: z.object({
    name: z.string().trim().min(1).max(160), email: z.string().email().max(254).nullable().optional(), phone: phone.nullable().optional(),
    company: z.string().max(160).nullable().optional(), source: z.string().max(60).nullable().optional(),
    status: z.enum(['new', 'contacted', 'qualified', 'lost']).default('new'), ownerId: uuid.nullable().optional(), notes: z.string().max(5000).default(''),
  }),
  list: { sortable: { name: 'leads.name', created_at: 'leads.created_at' }, filterable: { status: 'leads.status', owner_id: 'leads.owner_id' }, defaultSort: '-created_at' },
  searchColumns: ['leads.name', 'leads.email', 'leads.company'],
});

crudResource({
  module: M, moduleFlag: FLAG, path: '/contacts', table: 'contacts', resource: 'contacts', softDelete: true, rowVersion: true,
  create: z.object({
    name: z.string().trim().min(1).max(160), email: z.string().email().max(254).nullable().optional(), phone: phone.nullable().optional(),
    jobTitle: z.string().max(120).nullable().optional(), customerId: uuid.nullable().optional(),
  }),
  list: { sortable: { name: 'contacts.name', created_at: 'contacts.created_at' }, filterable: { customer_id: 'contacts.customer_id' }, defaultSort: 'name' },
  searchColumns: ['contacts.name', 'contacts.email'],
});

crudResource({
  module: M, moduleFlag: FLAG, path: '/enquiries', table: 'enquiries', resource: 'enquiries', softDelete: true, rowVersion: true,
  create: z.object({
    subject: z.string().trim().min(2).max(200), message: z.string().trim().min(1).max(10000), customerId: uuid.nullable().optional(),
    contactId: uuid.nullable().optional(), status: z.enum(['open', 'in_progress', 'resolved', 'closed']).default('open'), assigneeId: uuid.nullable().optional(),
  }),
  list: { sortable: { created_at: 'enquiries.created_at' }, filterable: { status: 'enquiries.status', customer_id: 'enquiries.customer_id' }, defaultSort: '-created_at' },
  searchColumns: ['enquiries.subject'],
  hooks: {
    async afterCreate(c, trx, row) {
      if (row.customer_id) await logActivity(trx, c.orgId(), row.customer_id as string, 'enquiry', `Enquiry: ${row.subject}`, c.auth!.userId, { type: 'enquiry', id: row.id as string });
    },
  },
});

crudResource({
  module: M, moduleFlag: FLAG, path: '/follow-ups', table: 'follow_ups', resource: 'follow_ups', softDelete: true, rowVersion: true,
  create: z.object({
    title: z.string().trim().min(2).max(200), dueAt: z.string().datetime(), customerId: uuid.nullable().optional(), leadId: uuid.nullable().optional(),
    assigneeId: uuid.nullable().optional(), status: z.enum(['open', 'done', 'cancelled']).default('open'),
  }),
  list: { sortable: { due_at: 'follow_ups.due_at', created_at: 'follow_ups.created_at' }, filterable: { status: 'follow_ups.status', assignee_id: 'follow_ups.assignee_id' }, defaultSort: 'due_at' },
  hooks: {
    async beforeCreate(c, _trx, input) {
      const i = input as { customerId?: string | null; leadId?: string | null };
      if (!i.customerId && !i.leadId) throw new AppError('VALIDATION_FAILED', 'A follow-up must reference a client or a lead', [{ field: 'customerId', issue: 'required' }]);
      return { assignee_id: (input as { assigneeId?: string | null }).assigneeId ?? c.auth!.userId };
    },
  },
});

// ---- conversion + client history -----------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/leads/:id/convert', module: M, moduleFlag: FLAG, summary: 'Convert a lead into a client (billing customer + contact)',
  access: { permission: 'leads:update' }, params: idParams, idempotent: true, response: obj,
  audit: { action: 'lead.converted', resourceType: 'lead' },
  async handler(c) {
    const lead = await c.trx('leads').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').forUpdate().first();
    if (!lead) throw new AppError('NOT_FOUND', 'Lead not found');
    if (lead.status === 'converted') throw new AppError('CONFLICT', 'Lead is already converted');
    const customerId = newId();
    try {
      await c.trx('billing_customers').insert({
        id: customerId, organization_id: c.orgId(), name: lead.company || lead.name, email: lead.email,
        currency: 'USD', created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    } catch (e) { throw mapDbError(e); }
    const existingContact = lead.email ? await c.trx('contacts').where({ organization_id: c.orgId(), email: lead.email }).whereNull('deleted_at').first() : null;
    let contactId: string;
    if (existingContact) {
      contactId = existingContact.id;
      await c.trx('contacts').where({ id: contactId }).update({ customer_id: customerId });
    } else {
      contactId = newId();
      await c.trx('contacts').insert({
        id: contactId, organization_id: c.orgId(), customer_id: customerId, name: lead.name, email: lead.email, phone: lead.phone,
        created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    }
    await c.trx('leads').where({ id: lead.id }).update({ status: 'converted', converted_customer_id: customerId, updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1') });
    await logActivity(c.trx, c.orgId(), customerId, 'converted', `Converted from lead ${lead.name}`, c.auth!.userId, { type: 'lead', id: lead.id });
    return { status: 200, data: { customerId, contactId, leadId: lead.id }, auditResourceId: lead.id };
  },
});

defineRoute({
  method: 'post', path: '/clients/:id/activities', module: M, moduleFlag: FLAG, summary: 'Log a note/call/meeting on a client',
  access: { permission: 'contacts:update' }, params: idParams,
  body: z.object({ kind: z.enum(['note', 'call', 'meeting', 'email']), summary: z.string().trim().min(1).max(2000) }), response: obj,
  async handler(c) {
    const cust = await c.trx('billing_customers').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!cust) throw new AppError('NOT_FOUND', 'Client not found');
    await logActivity(c.trx, c.orgId(), cust.id, c.body.kind, c.body.summary, c.auth!.userId);
    return { status: 201, data: { customerId: cust.id, kind: c.body.kind } };
  },
});

defineRoute({
  method: 'get', path: '/clients/:id/history', module: M, moduleFlag: FLAG, summary: 'Client timeline: activities, enquiries, invoices',
  access: { permission: 'contacts:read' }, params: idParams, response: obj,
  async handler(c) {
    const cust = await c.trx('billing_customers').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!cust) throw new AppError('NOT_FOUND', 'Client not found');
    const acts = await c.trx('client_activities').where({ customer_id: cust.id }).orderBy('occurred_at', 'desc').limit(200);
    const invoices = await c.trx('invoices').where({ customer_id: cust.id, organization_id: c.orgId() }).whereNot('status', 'draft').select('id', 'number', 'status', 'total', 'currency', 'sent_at');
    const enquiries = await c.trx('enquiries').where({ customer_id: cust.id, organization_id: c.orgId() }).whereNull('deleted_at').select('id', 'subject', 'status', 'created_at');
    const timeline = [
      ...acts.map((a) => ({ at: new Date(a.occurred_at).toISOString(), type: a.kind, summary: a.summary })),
      ...invoices.map((i) => ({ at: i.sent_at ? new Date(i.sent_at).toISOString() : null, type: 'invoice', summary: `Invoice ${i.number} (${i.status}) ${i.total} ${i.currency}` })),
      ...enquiries.map((e) => ({ at: new Date(e.created_at).toISOString(), type: 'enquiry', summary: `${e.subject} (${e.status})` })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { data: { customerId: cust.id, name: cust.name, timeline } };
  },
});

// follow-up reminders (daily job): due within 24h and not yet reminded
export async function remindFollowUps(svc: Services): Promise<number> {
  const due = await withPlatformScope(svc.db, 'followups', (t) =>
    t('follow_ups').where({ status: 'open' }).whereNull('reminded_at').whereNull('deleted_at')
      .where('due_at', '<', new Date(svc.now().getTime() + 24 * 3600_000)).select('id', 'organization_id', 'assignee_id', 'title'));
  for (const f of due) {
    await withTenant(svc.db, { organizationId: f.organization_id, userId: null }, async (trx) => {
      await trx('follow_ups').where({ id: f.id }).update({ reminded_at: svc.now() });
      await svc.events.emit(trx, 'followup.reminder', f.organization_id, { followUpId: f.id, title: f.title, assigneeId: f.assignee_id });
    });
  }
  return due.length;
}
jobRegistrars.push((svc) => { svc.jobs.work('reminders', async () => { await remindFollowUps(svc); }); });

// ---- client portal (separate auth realm) -------------------------------------------------------------------------------------

const portalSecret = (svc: Services) => new TextEncoder().encode(`${svc.env.JWT_SECRET}:portal`);
const PORTAL_ISSUER = 'zellavora-nexus-portal';
const PORTAL_TTL_MIN = 30;

async function portalAuth(svc: Services, req: Request) {
  const h = req.get('authorization');
  if (!h?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  try {
    const { payload } = await jwtVerify(h.slice(7), portalSecret(svc), { issuer: PORTAL_ISSUER, audience: 'portal', algorithms: ['HS256'] });
    const acct = await withPlatformScope(svc.db, 'portal-auth', (t) => t('portal_accounts').where({ id: payload.sub as string }).first());
    if (!acct || acct.status !== 'active') throw new Error('inactive');
    const org = await svc.db('organizations').where({ id: acct.organization_id }).first();
    if (!org || org.status !== 'active') throw new Error('tenant');
    return { accountId: acct.id as string, organizationId: acct.organization_id as string, customerId: acct.customer_id as string };
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
}

defineRoute({
  method: 'post', path: '/clients/:id/portal-accounts', module: M, moduleFlag: FLAG, summary: 'Invite a client contact to the portal',
  access: { permission: 'portal_accounts:create' }, params: idParams, rateLimit: 'invitation',
  body: z.object({ email: z.string().trim().toLowerCase().email().max(254), name: z.string().trim().min(1).max(120) }), response: obj,
  audit: { action: 'portal_account.invited', resourceType: 'portal_account' },
  async handler(c) {
    const cust = await c.trx('billing_customers').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!cust) throw new AppError('NOT_FOUND', 'Client not found');
    const token = randomToken();
    const id = newId();
    try {
      await c.trx('portal_accounts').insert({
        id, organization_id: c.orgId(), customer_id: cust.id, email: c.body.email, name: c.body.name, setup_token_hash: sha256(token),
        setup_expires_at: new Date(c.svc.now().getTime() + 72 * 3600_000), created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    } catch (e) { throw mapDbError(e); }
    await c.svc.mail.send({ to: c.body.email, subject: 'Your client portal access', text: `Set your portal password with this token: ${token}` });
    return { status: 201, data: { id, email: c.body.email, status: 'invited' } };
  },
});

defineRoute({
  method: 'post', path: '/portal/auth/set-password', module: 'portal', moduleFlag: FLAG, summary: 'Activate a portal account',
  access: 'public', rateLimit: 'auth', body: z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(256) }), response: obj,
  async handler(c) {
    const a = await c.trx('portal_accounts').where({ setup_token_hash: sha256(c.body.token) }).where('setup_expires_at', '>', c.svc.now()).first();
    if (!a) throw new AppError('VALIDATION_FAILED', 'Invalid or expired token', [{ field: 'token', issue: 'invalid' }]);
    const issues = passwordProblems(c.body.password, DEFAULT_PASSWORD_POLICY, { email: a.email });
    if (issues.length) throw new AppError('VALIDATION_FAILED', 'Password does not meet the policy', issues.map((i) => ({ field: 'password', issue: i })));
    await c.trx('portal_accounts').where({ id: a.id }).update({ password_hash: await hashPassword(c.body.password), status: 'active', setup_token_hash: null, setup_expires_at: null });
    return { status: 200, data: { message: 'Account activated' } };
  },
});

defineRoute({
  method: 'post', path: '/portal/auth/login', module: 'portal', moduleFlag: FLAG, summary: 'Client portal login',
  access: 'public', rateLimit: 'auth',
  body: z.object({ organizationCode: z.string().trim().toLowerCase().max(40), email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(256) }),
  response: obj,
  async handler(c) {
    const fail = () => new AppError('UNAUTHENTICATED', 'Invalid credentials');
    const org = await c.trx('organizations').where({ code: c.body.organizationCode, status: 'active' }).first();
    const a = org ? await c.trx('portal_accounts').where({ organization_id: org.id, email: c.body.email }).first() : null;
    if (!a || a.status !== 'active' || !a.password_hash || (a.locked_until && new Date(a.locked_until) > c.svc.now())) {
      await dummyVerify(c.body.password);
      throw fail();
    }
    if (!(await verifyPassword(a.password_hash, c.body.password))) {
      const n = a.failed_count + 1;
      await c.trx('portal_accounts').where({ id: a.id }).update({ failed_count: n, locked_until: n >= 5 ? new Date(c.svc.now().getTime() + 15 * 60_000) : null });
      return { errorAfterCommit: fail() };
    }
    await c.trx('portal_accounts').where({ id: a.id }).update({ failed_count: 0, locked_until: null, last_login_at: c.svc.now() });
    const token = await new SignJWT({ org: a.organization_id, cust: a.customer_id })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(a.id).setIssuer(PORTAL_ISSUER).setAudience('portal')
      .setIssuedAt().setExpirationTime(`${PORTAL_TTL_MIN}m`).sign(portalSecret(c.svc));
    return { status: 200, data: { accessToken: token, expiresIn: PORTAL_TTL_MIN * 60 } };
  },
});

async function portalScope<T>(svc: Services, req: Request, fn: (trx: Trx, p: { accountId: string; organizationId: string; customerId: string }) => Promise<T>): Promise<T> {
  const p = await portalAuth(svc, req);
  return withTenant(svc.db, { organizationId: p.organizationId, userId: null }, (trx) => fn(trx, p));
}

defineRoute({
  method: 'get', path: '/portal/me/invoices', module: 'portal', moduleFlag: FLAG, summary: 'My invoices (own client only)', access: 'public', response: obj,
  async handler(c) {
    return { status: 200, data: await portalScope(c.svc, c.req, async (trx, p) => {
      const rows = await trx('invoices').where({ organization_id: p.organizationId, customer_id: p.customerId }).whereIn('status', ['sent', 'partially_paid', 'paid', 'overdue']).orderBy('created_at', 'desc');
      return rows.map((r) => ({ id: r.id, number: r.number, status: r.status, total: r.total, balance: r.balance, currency: r.currency, dueDate: r.due_date }));
    }) };
  },
});

defineRoute({
  method: 'get', path: '/portal/me/enquiries', module: 'portal', moduleFlag: FLAG, summary: 'My enquiries', access: 'public', response: obj,
  async handler(c) {
    return { status: 200, data: await portalScope(c.svc, c.req, async (trx, p) => {
      const rows = await trx('enquiries').where({ organization_id: p.organizationId, customer_id: p.customerId }).whereNull('deleted_at').orderBy('created_at', 'desc');
      return rows.map((r) => ({ id: r.id, subject: r.subject, status: r.status, createdAt: new Date(r.created_at).toISOString() }));
    }) };
  },
});

defineRoute({
  method: 'post', path: '/portal/me/enquiries', module: 'portal', moduleFlag: FLAG, summary: 'Submit an enquiry', access: 'public', rateLimit: 'invitation',
  body: z.object({ subject: z.string().trim().min(2).max(200), message: z.string().trim().min(1).max(10000) }), response: obj,
  async handler(c) {
    return { status: 201, data: await portalScope(c.svc, c.req, async (trx, p) => {
      const id = newId();
      await trx('enquiries').insert({
        id, organization_id: p.organizationId, customer_id: p.customerId, subject: c.body.subject, message: c.body.message, via_portal: true,
      });
      await logActivity(trx, p.organizationId, p.customerId, 'enquiry', `Portal enquiry: ${c.body.subject}`, null, { type: 'enquiry', id });
      return { id };
    }) };
  },
});

defineRoute({
  method: 'get', path: '/portal/me/documents', module: 'portal', moduleFlag: FLAG, summary: 'Documents shared with me', access: 'public', response: obj,
  async handler(c) {
    return { status: 200, data: await portalScope(c.svc, c.req, async (trx, p) => {
      const meta = await trx('document_metadata').where({ organization_id: p.organizationId, key: 'portal_customer_id', value: p.customerId }).select('document_id');
      if (meta.length === 0) return [];
      const docs = await trx('documents as d').join('document_versions as v', function () { this.on('v.document_id', 'd.id').andOn('v.version', 'd.current_version'); })
        .join('files as f', 'f.id', 'v.file_id').whereIn('d.id', meta.map((m) => m.document_id)).whereNull('d.deleted_at').where('f.scan_status', 'clean')
        .select('d.id', 'd.title', 'f.original_filename', 'f.content_type', 'f.size');
      return docs.map((d) => ({ id: d.id, title: d.title, filename: d.original_filename, contentType: d.content_type, size: Number(d.size) }));
    }) };
  },
});

void fileDto; void isFlagEnabled; void listQuerySchema; void paginate; void rowToApi;
export type { ListQuery, HandlerCtx };
