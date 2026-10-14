import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { Decimal } from 'decimal.js';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { crudResource, rowToApi, mapDbError } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { D, computeLine, currencyDecimals, round, sumLines, type RoundingMode } from '../../platform/money.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { registerExportKind, requestExport } from '../data/exports.js';
import { registerWidget } from '../dashboard/registry.js';
import type { Services } from '../../platform/types.js';

const M = 'invoices';
const FLAG = 'module.invoices';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currencyCode = z.string().length(3).regex(/^[A-Z]{3}$/);
const decimalInput = z.union([z.string().regex(/^\d{1,15}(\.\d{1,6})?$/), z.number().nonnegative().max(1e12)]).transform((v) => String(v));
const OPEN = ['sent', 'partially_paid', 'overdue'];

// ---- setup entities ------------------------------------------------------------------------------------------------

crudResource({
  module: M, moduleFlag: FLAG, path: '/billing-customers', table: 'billing_customers', resource: 'customers', softDelete: true, rowVersion: true,
  create: z.object({
    name: z.string().trim().min(2).max(160), email: z.string().email().max(254).nullable().optional(), taxId: z.string().max(40).nullable().optional(),
    address: z.record(z.string(), z.string().max(200)).default({}), currency: currencyCode.default('USD'),
  }),
  list: { sortable: { name: 'billing_customers.name', created_at: 'billing_customers.created_at' }, defaultSort: 'name' },
  searchColumns: ['billing_customers.name', 'billing_customers.email'],
});

crudResource({
  module: M, moduleFlag: FLAG, path: '/tax-configurations', table: 'tax_configurations', resource: 'tax_configs',
  create: z.object({
    name: z.string().trim().min(2).max(80), rate: z.number().min(0).max(100), inclusive: z.boolean().default(false),
    compound: z.boolean().default(false), effectiveFrom: date.optional(), effectiveTo: date.nullable().optional(), active: z.boolean().default(true),
  }),
  list: { sortable: { name: 'tax_configurations.name', created_at: 'tax_configurations.created_at' }, defaultSort: 'name' },
});

defineRoute({
  method: 'put', path: '/numbering-rules/:series', module: M, moduleFlag: FLAG, summary: 'Configure a numbering series',
  access: { permission: 'invoices:configure' }, params: z.object({ series: z.string().regex(/^[a-z0-9_]{2,30}$/) }),
  body: z.object({ prefix: z.string().max(12), padding: z.number().int().min(1).max(12).default(5), resetYearly: z.boolean().default(true) }),
  response: obj, audit: { action: 'numbering_rule.changed', resourceType: 'numbering_sequence' },
  async handler(c) {
    await c.trx('numbering_sequences').where({ organization_id: c.orgId(), series: c.params.series })
      .update({ prefix: c.body.prefix, padding: c.body.padding, reset_yearly: c.body.resetYearly });
    const exists = await c.trx('numbering_sequences').where({ organization_id: c.orgId(), series: c.params.series }).first();
    if (!exists) {
      const period = c.body.resetYearly ? String(c.svc.now().getUTCFullYear()) : '';
      await c.trx('numbering_sequences').insert({
        id: newId(), organization_id: c.orgId(), series: c.params.series, period, prefix: c.body.prefix, padding: c.body.padding, reset_yearly: c.body.resetYearly,
      });
    }
    return { status: 200, data: { series: c.params.series, ...c.body } };
  },
});

defineRoute({
  method: 'get', path: '/numbering-rules', module: M, moduleFlag: FLAG, summary: 'Numbering series',
  access: { permission: 'invoices:read' }, response: obj,
  async handler(c) {
    return { data: (await c.trx('numbering_sequences').where({ organization_id: c.orgId() }).orderBy(['series', 'period'])).map((r) => rowToApi(r)) };
  },
});

/** Gap-free: the counter row is locked and incremented inside the caller's transaction. */
export async function allocateNumber(trx: Trx, orgId: string, series: string, onDate: Date): Promise<string> {
  const known = await trx('numbering_sequences').where({ organization_id: orgId, series }).orderBy('period', 'desc').first();
  const cfg = known ?? { prefix: series === 'credit_note' ? 'CN-' : 'INV-', padding: 5, reset_yearly: true };
  const year = String(onDate.getUTCFullYear());
  const period = cfg.reset_yearly ? year : '';
  await trx('numbering_sequences').insert({
    id: newId(), organization_id: orgId, series, period, prefix: cfg.prefix, padding: cfg.padding, reset_yearly: cfg.reset_yearly,
  }).onConflict(['organization_id', 'series', 'period']).ignore();
  const seq = await trx('numbering_sequences').where({ organization_id: orgId, series, period }).forUpdate().first();
  await trx('numbering_sequences').where({ id: seq.id }).update({ next_number: Number(seq.next_number) + 1 });
  const n = String(seq.next_number).padStart(seq.padding, '0');
  return `${seq.prefix}${cfg.reset_yearly ? `${year}-` : ''}${n}`;
}

// ---- invoice building ----------------------------------------------------------------------------------------------

const lineSchema = z.object({
  description: z.string().trim().min(1).max(500), quantity: decimalInput, unitPrice: decimalInput,
  discountPct: z.number().min(0).max(100).default(0), taxIds: z.array(uuid).max(3).default([]), projectId: uuid.nullable().optional(),
});
type LineIn = z.infer<typeof lineSchema>;

async function roundingMode(trx: Trx, orgId: string): Promise<RoundingMode> {
  const s = await trx('organization_settings').where({ organization_id: orgId, key: 'invoices.rounding' }).first();
  return (s?.value as RoundingMode) ?? 'half_up';
}

async function writeLines(trx: Trx, orgId: string, invoiceId: string, currency: string, onDate: string, lines: LineIn[]) {
  if (lines.length === 0) throw new AppError('VALIDATION_FAILED', 'At least one line is required', [{ field: 'lines', issue: 'empty' }]);
  const mode = await roundingMode(trx, orgId);
  const ids = [...new Set(lines.flatMap((l) => l.taxIds))];
  const taxes = ids.length
    ? await trx('tax_configurations').where({ organization_id: orgId, active: true }).whereIn('id', ids)
      .where('effective_from', '<=', onDate).where((w) => w.whereNull('effective_to').orWhere('effective_to', '>=', onDate))
    : [];
  if (taxes.length !== ids.length) throw new AppError('VALIDATION_FAILED', 'A tax configuration is unknown or not effective on the invoice date', [{ field: 'lines.taxIds', issue: 'invalid_tax' }]);
  const byId = new Map(taxes.map((t) => [t.id as string, t]));
  const results = lines.map((l) => computeLine({
    quantity: l.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct,
    taxes: l.taxIds.map((id) => ({ rate: byId.get(id)!.rate, inclusive: byId.get(id)!.inclusive, compound: byId.get(id)!.compound })),
  }, currency, mode));
  await trx('invoice_lines').where({ invoice_id: invoiceId }).delete();
  const fix = (v: Decimal) => v.toFixed(currencyDecimals(currency));
  await trx('invoice_lines').insert(lines.map((l, i) => ({
    id: newId(), organization_id: orgId, invoice_id: invoiceId, position: i + 1, description: l.description, quantity: l.quantity,
    unit_price: l.unitPrice, discount_pct: l.discountPct, tax_ids: l.taxIds, project_id: l.projectId ?? null,
    line_subtotal: fix(results[i]!.subtotal), line_discount: fix(results[i]!.discount), line_tax: fix(results[i]!.tax), line_total: fix(results[i]!.total),
  })));
  return sumLines(results, currency);
}

async function history(trx: Trx, orgId: string, invoiceId: string, from: string | null, to: string, actor: string | null, note?: string) {
  await trx('invoice_status_history').insert({ id: newId(), organization_id: orgId, invoice_id: invoiceId, from_status: from, to_status: to, actor_id: actor, note: note ?? null });
}

async function invoiceDto(trx: Trx, orgId: string, inv: Record<string, unknown>) {
  const lines = await trx('invoice_lines').where({ invoice_id: inv.id, organization_id: orgId }).orderBy('position');
  return { ...rowToApi(inv), lines: lines.map((l) => rowToApi(l)) };
}

async function loadInvoice(c: HandlerCtx, id: string, lock = false) {
  const q = c.trx('invoices').where({ id, organization_id: c.orgId() });
  const inv = await (lock ? q.forUpdate() : q).first();
  if (!inv) throw new AppError('NOT_FOUND', 'Invoice not found');
  return inv;
}

const invoiceBody = z.object({
  customerId: uuid, currency: currencyCode.optional(), issueDate: date.optional(), dueDate: date.optional(),
  notes: z.string().max(2000).default(''), lines: z.array(lineSchema).min(1).max(200),
});

defineRoute({
  method: 'post', path: '/invoices', module: M, moduleFlag: FLAG, summary: 'Create a draft invoice (totals computed server-side)',
  access: { permission: 'invoices:create' }, idempotent: true, body: invoiceBody, response: obj,
  audit: { action: 'invoice.created', resourceType: 'invoice' },
  async handler(c) {
    const cust = await c.trx('billing_customers').where({ id: c.body.customerId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!cust) throw new AppError('VALIDATION_FAILED', 'Customer not found', [{ field: 'customerId', issue: 'not_found' }]);
    const currency = c.body.currency ?? cust.currency;
    const id = newId();
    const onDate = c.body.issueDate ?? c.svc.now().toISOString().slice(0, 10);
    await c.trx('invoices').insert({
      id, organization_id: c.orgId(), customer_id: cust.id, currency, issue_date: c.body.issueDate ?? null, due_date: c.body.dueDate ?? null,
      notes: c.body.notes, created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    const t = await writeLines(c.trx, c.orgId(), id, currency, onDate, c.body.lines);
    await c.trx('invoices').where({ id }).update({ subtotal: t.subtotal, discount_total: t.discountTotal, tax_total: t.taxTotal, total: t.total, balance: t.total });
    await history(c.trx, c.orgId(), id, null, 'draft', c.auth!.userId);
    return { status: 201, data: await invoiceDto(c.trx, c.orgId(), await c.trx('invoices').where({ id }).first()) };
  },
});

defineRoute({
  method: 'get', path: '/invoices', module: M, moduleFlag: FLAG, summary: 'List invoices',
  access: { permission: 'invoices:read' }, query: listQuerySchema.extend({ customerId: uuid.optional() }), response: obj,
  async handler(c) {
    const q = c.query as { customerId?: string } & ListQuery;
    const qb = c.trx('invoices').where({ organization_id: c.orgId() });
    if (q.customerId) qb.where({ customer_id: q.customerId });
    if (q.q) qb.whereILike('number', `%${q.q}%`);
    const page = await paginate(qb, q, {
      sortable: { created_at: 'created_at', due_date: 'due_date', total: 'total', number: 'number' }, filterable: { status: 'status', series: 'series' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/invoices/:id', module: M, moduleFlag: FLAG, summary: 'Invoice with lines and history',
  access: { permission: 'invoices:read' }, params: idParams, response: obj,
  async handler(c) {
    const inv = await loadInvoice(c, c.params.id);
    const hist = await c.trx('invoice_status_history').where({ invoice_id: inv.id }).orderBy('occurred_at');
    return { data: { ...(await invoiceDto(c.trx, c.orgId(), inv)), history: hist.map((h) => rowToApi(h)) } };
  },
});

defineRoute({
  method: 'patch', path: '/invoices/:id', module: M, moduleFlag: FLAG, summary: 'Edit a draft invoice',
  access: { permission: 'invoices:update' }, params: idParams,
  body: z.object({ currency: currencyCode.optional(), issueDate: date.optional(), dueDate: date.nullable().optional(), notes: z.string().max(2000).optional(), lines: z.array(lineSchema).min(1).max(200).optional(), rowVersion: z.number().int().optional() }),
  response: obj, audit: { action: 'invoice.updated', resourceType: 'invoice' },
  async handler(c) {
    const inv = await loadInvoice(c, c.params.id, true);
    if (inv.status !== 'draft') throw new AppError('CONFLICT', 'Only draft invoices can be edited; use a credit note for sent invoices');
    if (c.body.rowVersion !== undefined && c.body.rowVersion !== inv.row_version) throw new AppError('PRECONDITION_FAILED', 'The invoice was modified by someone else; reload and retry');
    const currency = c.body.currency ?? inv.currency;
    const patch: Record<string, unknown> = { currency, updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') };
    if (c.body.issueDate !== undefined) patch.issue_date = c.body.issueDate;
    if (c.body.dueDate !== undefined) patch.due_date = c.body.dueDate;
    if (c.body.notes !== undefined) patch.notes = c.body.notes;
    if (c.body.lines || currency !== inv.currency) {
      const lines = c.body.lines ?? (await c.trx('invoice_lines').where({ invoice_id: inv.id }).orderBy('position')).map((l) => ({
        description: l.description, quantity: String(l.quantity), unitPrice: String(l.unit_price), discountPct: Number(l.discount_pct), taxIds: l.tax_ids, projectId: l.project_id,
      }));
      const t = await writeLines(c.trx, c.orgId(), inv.id, currency, (c.body.issueDate ?? inv.issue_date?.toISOString?.().slice(0, 10)) ?? c.svc.now().toISOString().slice(0, 10), lines as LineIn[]);
      Object.assign(patch, { subtotal: t.subtotal, discount_total: t.discountTotal, tax_total: t.taxTotal, total: t.total, balance: t.total });
    }
    await c.trx('invoices').where({ id: inv.id }).update(patch);
    return { status: 200, data: await invoiceDto(c.trx, c.orgId(), await c.trx('invoices').where({ id: inv.id }).first()) };
  },
});

defineRoute({
  method: 'delete', path: '/invoices/:id', module: M, moduleFlag: FLAG, summary: 'Delete a draft invoice',
  access: { permission: 'invoices:delete' }, params: idParams, audit: { action: 'invoice.deleted', resourceType: 'invoice' },
  async handler(c) {
    const inv = await loadInvoice(c, c.params.id, true);
    if (inv.status !== 'draft') throw new AppError('CONFLICT', 'Only draft invoices can be deleted');
    await c.trx('time_entries').where({ invoice_id: inv.id }).update({ invoice_id: null });
    await c.trx('invoices').where({ id: inv.id }).delete().catch((e) => { throw mapDbError(e); });
    return { status: 204, auditResourceId: inv.id };
  },
});

defineRoute({
  method: 'post', path: '/invoices/:id/send', module: M, moduleFlag: FLAG, summary: 'Issue the invoice (assigns the gap-free number)',
  access: { permission: 'invoices:send' }, params: idParams, idempotent: 'required', response: obj,
  audit: { action: 'invoice.sent', resourceType: 'invoice' },
  async handler(c) {
    const inv = await loadInvoice(c, c.params.id, true);
    if (inv.status !== 'draft') throw new AppError('CONFLICT', `A ${inv.status} invoice cannot be sent`);
    const issue = inv.issue_date ? new Date(inv.issue_date) : c.svc.now();
    const terms = Number((await c.trx('organization_settings').where({ organization_id: c.orgId(), key: 'invoices.default_payment_terms_days' }).first())?.value ?? 30);
    const due = inv.due_date ?? new Date(issue.getTime() + terms * 86400_000);
    if (new Date(due) < new Date(issue.toISOString().slice(0, 10))) throw new AppError('VALIDATION_FAILED', 'Due date cannot be before the issue date', [{ field: 'dueDate', issue: 'before_issue' }]);
    const number = await allocateNumber(c.trx, c.orgId(), inv.series, issue);
    await c.trx('invoices').where({ id: inv.id }).update({
      status: 'sent', number, issue_date: issue.toISOString().slice(0, 10), due_date: new Date(due).toISOString().slice(0, 10),
      sent_at: c.svc.now(), updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1'),
    });
    await history(c.trx, c.orgId(), inv.id, 'draft', 'sent', c.auth!.userId);
    await c.emit('invoice.sent', { invoiceId: inv.id, number });
    return { status: 200, data: { id: inv.id, number, status: 'sent' } };
  },
});

defineRoute({
  method: 'post', path: '/invoices/:id/void', module: M, moduleFlag: FLAG, summary: 'Void an unpaid invoice',
  access: { permission: 'invoices:void' }, params: idParams, body: z.object({ reason: z.string().trim().min(3).max(300) }), idempotent: true,
  response: obj, audit: { action: 'invoice.voided', resourceType: 'invoice' },
  async handler(c) {
    const inv = await loadInvoice(c, c.params.id, true);
    if (!['draft', 'sent', 'overdue'].includes(inv.status) || D(inv.amount_paid).gt(0) || D(inv.amount_credited).gt(0)) {
      throw new AppError('CONFLICT', 'Only unpaid, uncredited invoices can be voided; issue a credit note instead');
    }
    await c.trx('invoices').where({ id: inv.id }).update({
      status: 'void', voided_at: c.svc.now(), void_reason: c.body.reason, balance: 0, updated_at: c.svc.now(), updated_by: c.auth!.userId,
      row_version: c.trx.raw('row_version + 1'),
    });
    await c.trx('time_entries').where({ invoice_id: inv.id }).update({ invoice_id: null });
    await history(c.trx, c.orgId(), inv.id, inv.status, 'void', c.auth!.userId, c.body.reason);
    return { status: 200, data: { id: inv.id, status: 'void' } };
  },
});

// ---- PDF ------------------------------------------------------------------------------------------------------------

export async function renderInvoicePdf(inv: Record<string, unknown>, lines: Record<string, unknown>[], customer: Record<string, unknown>, orgName: string): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 48, info: { Title: `Invoice ${inv.number ?? 'draft'}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  doc.fontSize(20).text(orgName, { align: 'left' }).moveDown(0.5);
  doc.fontSize(14).text(`Invoice ${inv.number ?? '(draft)'}`).fontSize(10)
    .text(`Status: ${inv.status}`).text(`Issued: ${inv.issue_date ? new Date(inv.issue_date as string).toISOString().slice(0, 10) : '-'}`)
    .text(`Due: ${inv.due_date ? new Date(inv.due_date as string).toISOString().slice(0, 10) : '-'}`).moveDown();
  doc.text(`Bill to: ${customer.name}`).moveDown();
  doc.fontSize(10).text('Description', 48, doc.y, { continued: true, width: 280 }).text('Qty', { continued: true, width: 60 }).text('Total', { align: 'right' });
  doc.moveTo(48, doc.y + 2).lineTo(547, doc.y + 2).stroke().moveDown(0.5);
  for (const l of lines) {
    doc.text(String(l.description), 48, doc.y, { continued: true, width: 280 }).text(String(l.quantity), { continued: true, width: 60 }).text(`${l.line_total} ${inv.currency}`, { align: 'right' });
  }
  doc.moveDown().text(`Subtotal: ${inv.subtotal} ${inv.currency}`, { align: 'right' }).text(`Tax: ${inv.tax_total} ${inv.currency}`, { align: 'right' });
  doc.fontSize(12).text(`Total: ${inv.total} ${inv.currency}`, { align: 'right' }).fontSize(10).text(`Balance due: ${inv.balance} ${inv.currency}`, { align: 'right' });
  if (inv.notes) doc.moveDown().text(String(inv.notes));
  doc.end();
  return done;
}

defineRoute({
  method: 'get', path: '/invoices/:id/pdf', module: M, moduleFlag: FLAG, summary: 'Invoice PDF', access: { permission: 'invoices:read' },
  params: idParams, binary: true,
  async handler(c) {
    const inv = await loadInvoice(c, c.params.id);
    const lines = await c.trx('invoice_lines').where({ invoice_id: inv.id }).orderBy('position');
    const cust = await c.trx('billing_customers').where({ id: inv.customer_id }).first();
    const org = await c.trx('organizations').where({ id: c.orgId() }).first();
    await c.audit({ action: 'invoice.pdf_downloaded', resourceType: 'invoice', resourceId: inv.id });
    return { status: 200, raw: { contentType: 'application/pdf', body: await renderInvoicePdf(inv, lines, cust, org.name), filename: `invoice-${inv.number ?? inv.id}.pdf` } };
  },
});

// ---- payments & allocation (F-214) -------------------------------------------------------------------------------------

interface Alloc { invoiceId: string; amount: string }

async function allocate(trx: Trx, orgId: string, actorId: string, payment: Record<string, unknown>, allocations: Alloc[]) {
  const sorted = [...allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId)); // consistent lock order
  let remaining = D(payment.unallocated as string);
  for (const a of sorted) {
    const amount = D(a.amount);
    if (amount.lte(0)) throw new AppError('VALIDATION_FAILED', 'Allocation must be positive', [{ field: 'allocations', issue: 'non_positive' }]);
    const inv = await trx('invoices').where({ id: a.invoiceId, organization_id: orgId }).forUpdate().first();
    if (!inv || inv.customer_id !== payment.customer_id) throw new AppError('VALIDATION_FAILED', 'Invoice not found for this customer', [{ field: 'allocations', issue: a.invoiceId }]);
    if (!OPEN.includes(inv.status)) throw new AppError('CONFLICT', `Invoice ${inv.number ?? inv.id} is ${inv.status} and cannot receive payments`);
    if (inv.currency !== payment.currency) throw new AppError('VALIDATION_FAILED', 'Currency mismatch between payment and invoice', [{ field: 'allocations', issue: 'currency_mismatch' }]);
    if (amount.gt(D(inv.balance))) throw new AppError('VALIDATION_FAILED', 'Allocation exceeds the invoice balance', [{ field: 'allocations', issue: 'exceeds_balance' }]);
    if (amount.gt(remaining)) throw new AppError('VALIDATION_FAILED', 'Allocations exceed the unallocated payment amount', [{ field: 'allocations', issue: 'exceeds_payment' }]);
    remaining = remaining.minus(amount);
    const paid = D(inv.amount_paid).plus(amount);
    const balance = D(inv.balance).minus(amount);
    const status = balance.isZero() ? 'paid' : 'partially_paid';
    await trx('invoices').where({ id: inv.id }).update({
      amount_paid: paid.toFixed(4), balance: balance.toFixed(4), status, updated_at: new Date(), row_version: trx.raw('row_version + 1'),
    });
    await trx('payment_allocations').insert({ id: newId(), organization_id: orgId, payment_id: payment.id, invoice_id: inv.id, amount: amount.toFixed(4), created_by: actorId });
    if (status !== inv.status) await history(trx, orgId, inv.id, inv.status, status, actorId);
  }
  await trx('payments').where({ id: payment.id }).update({ unallocated: remaining.toFixed(4) });
}

const allocSchema = z.array(z.object({ invoiceId: uuid, amount: decimalInput })).max(100);

defineRoute({
  method: 'post', path: '/payments', module: M, moduleFlag: FLAG, summary: 'Record a payment (optionally allocating it)',
  access: { permission: 'payments:create' }, idempotent: 'required',
  body: z.object({
    customerId: uuid, amount: decimalInput, currency: currencyCode, method: z.enum(['manual', 'bank_transfer', 'card', 'cash', 'cheque']).default('manual'),
    reference: z.string().max(120).optional(), receivedOn: date.optional(), allocations: allocSchema.default([]),
  }),
  response: obj, audit: { action: 'payment.recorded', resourceType: 'payment' },
  async handler(c) {
    const cust = await c.trx('billing_customers').where({ id: c.body.customerId, organization_id: c.orgId() }).first();
    if (!cust) throw new AppError('VALIDATION_FAILED', 'Customer not found', [{ field: 'customerId', issue: 'not_found' }]);
    const amount = D(c.body.amount);
    if (amount.lte(0)) throw new AppError('VALIDATION_FAILED', 'Amount must be positive', [{ field: 'amount', issue: 'non_positive' }]);
    if (amount.decimalPlaces() > currencyDecimals(c.body.currency)) throw new AppError('VALIDATION_FAILED', 'Too many decimal places for the currency', [{ field: 'amount', issue: 'precision' }]);
    const id = newId();
    await c.trx('payments').insert({
      id, organization_id: c.orgId(), customer_id: cust.id, amount: amount.toFixed(4), unallocated: amount.toFixed(4), currency: c.body.currency,
      method: c.body.method, reference: c.body.reference ?? null, received_on: c.body.receivedOn ?? c.svc.now().toISOString().slice(0, 10),
      created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    if (c.body.allocations.length) await allocate(c.trx, c.orgId(), c.auth!.userId, await c.trx('payments').where({ id }).first(), c.body.allocations);
    await c.emit('payment.recorded', { paymentId: id });
    return { status: 201, data: rowToApi(await c.trx('payments').where({ id }).first()) };
  },
});

defineRoute({
  method: 'post', path: '/payments/:id/allocate', module: M, moduleFlag: FLAG, summary: 'Allocate an existing payment to invoices',
  access: { permission: 'payments:create' }, params: idParams, idempotent: 'required', body: z.object({ allocations: allocSchema.min(1) }),
  response: obj, audit: { action: 'payment.allocated', resourceType: 'payment' },
  async handler(c) {
    const p = await c.trx('payments').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!p) throw new AppError('NOT_FOUND', 'Payment not found');
    if (p.status !== 'recorded') throw new AppError('CONFLICT', 'Payment is not active');
    await allocate(c.trx, c.orgId(), c.auth!.userId, p, c.body.allocations);
    return { status: 200, data: rowToApi(await c.trx('payments').where({ id: p.id }).first()) };
  },
});

defineRoute({
  method: 'get', path: '/payments', module: M, moduleFlag: FLAG, summary: 'List payments',
  access: { permission: 'payments:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('payments').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { received_on: 'received_on', created_at: 'created_at', amount: 'amount' }, filterable: { customer_id: 'customer_id', status: 'status' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/payments/reconcile', module: M, moduleFlag: FLAG, summary: 'Match unallocated payments to invoices',
  access: { permission: 'payments:create' }, idempotent: 'required', body: z.object({ apply: z.boolean().default(false) }), response: obj,
  audit: { action: 'payment.reconciled', resourceType: 'payment' },
  async handler(c) {
    const open = await c.trx('payments').where({ organization_id: c.orgId(), status: 'recorded' }).where('unallocated', '>', 0).whereNotNull('reference').forUpdate();
    const matches: { paymentId: string; invoiceId: string; invoiceNumber: string; amount: string; applied: boolean }[] = [];
    for (const p of open) {
      const inv = await c.trx('invoices').where({ organization_id: c.orgId(), number: p.reference, customer_id: p.customer_id, currency: p.currency }).whereIn('status', OPEN).forUpdate().first();
      if (!inv) continue;
      const amount = Decimal.min(D(p.unallocated), D(inv.balance));
      if (!D(p.unallocated).equals(D(inv.balance))) continue; // exact matches only
      if (c.body.apply) await allocate(c.trx, c.orgId(), c.auth!.userId, p, [{ invoiceId: inv.id, amount: amount.toFixed(4) }]);
      matches.push({ paymentId: p.id, invoiceId: inv.id, invoiceNumber: inv.number, amount: amount.toFixed(4), applied: c.body.apply });
    }
    return { status: 200, data: { matches } };
  },
});

// ---- credit notes (F-213) -----------------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/invoices/:id/credit-notes', module: M, moduleFlag: FLAG, summary: 'Issue a credit note against an invoice',
  access: { permission: 'credit_notes:create' }, params: idParams, idempotent: 'required',
  body: z.object({ amount: decimalInput, reason: z.string().trim().min(3).max(300) }), response: obj,
  audit: { action: 'credit_note.issued', resourceType: 'credit_note' },
  async handler(c) {
    const inv = await loadInvoice(c, c.params.id, true);
    if (!OPEN.includes(inv.status) && inv.status !== 'paid') throw new AppError('CONFLICT', `Cannot credit a ${inv.status} invoice`);
    const amount = D(c.body.amount);
    if (amount.lte(0) || amount.decimalPlaces() > currencyDecimals(inv.currency)) throw new AppError('VALIDATION_FAILED', 'Invalid amount', [{ field: 'amount', issue: 'invalid' }]);
    const creditable = D(inv.total).minus(D(inv.amount_credited));
    if (amount.gt(creditable)) throw new AppError('VALIDATION_FAILED', 'Credit exceeds the invoice total', [{ field: 'amount', issue: 'exceeds_invoice' }]);
    const number = await allocateNumber(c.trx, c.orgId(), 'credit_note', c.svc.now());
    const id = newId();
    await c.trx('credit_notes').insert({ id, organization_id: c.orgId(), invoice_id: inv.id, number, amount: amount.toFixed(4), reason: c.body.reason, created_by: c.auth!.userId, updated_by: c.auth!.userId });
    const newCredited = D(inv.amount_credited).plus(amount);
    const newBalance = Decimal.max(D(0), D(inv.balance).minus(amount));
    const status = inv.status === 'paid' ? 'paid' : newBalance.isZero() ? 'paid' : inv.status;
    await c.trx('invoices').where({ id: inv.id }).update({
      amount_credited: newCredited.toFixed(4), balance: newBalance.toFixed(4), status, updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1'),
    });
    if (status !== inv.status) await history(c.trx, c.orgId(), inv.id, inv.status, status, c.auth!.userId, `credit note ${number}`);
    return { status: 201, data: { id, number, invoiceId: inv.id, amount: amount.toFixed(4), invoiceBalance: newBalance.toFixed(4) } };
  },
});

defineRoute({
  method: 'get', path: '/credit-notes', module: M, moduleFlag: FLAG, summary: 'List credit notes',
  access: { permission: 'credit_notes:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('credit_notes').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { created_at: 'created_at' }, filterable: { invoice_id: 'invoice_id' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

// ---- receivables, from timesheets, overdue job ---------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/receivables/summary', module: M, moduleFlag: FLAG, summary: 'Receivables aging buckets (0-30/31-60/61-90/90+)',
  access: { permission: 'invoices:read' }, query: z.object({ currency: currencyCode.default('USD') }), response: obj,
  async handler(c) {
    const today = c.svc.now().toISOString().slice(0, 10);
    const r = await c.trx.raw(
      `SELECT
         coalesce(sum(balance) FILTER (WHERE (?::date - due_date) <= 30), 0)::text AS b0_30,
         coalesce(sum(balance) FILTER (WHERE (?::date - due_date) BETWEEN 31 AND 60), 0)::text AS b31_60,
         coalesce(sum(balance) FILTER (WHERE (?::date - due_date) BETWEEN 61 AND 90), 0)::text AS b61_90,
         coalesce(sum(balance) FILTER (WHERE (?::date - due_date) > 90), 0)::text AS b90_plus,
         coalesce(sum(balance), 0)::text AS total, count(*)::int AS invoices
       FROM invoices WHERE organization_id = ? AND currency = ? AND status IN ('sent','partially_paid','overdue') AND balance > 0`,
      [today, today, today, today, c.orgId(), c.query.currency]);
    const row = r.rows[0];
    return { data: { currency: c.query.currency, buckets: { '0-30': row.b0_30, '31-60': row.b31_60, '61-90': row.b61_90, '90+': row.b90_plus }, total: row.total, invoices: row.invoices } };
  },
});

defineRoute({
  method: 'post', path: '/invoices/from-timesheets', module: M, moduleFlag: FLAG, summary: 'Create a draft invoice from approved billable time',
  access: { permission: 'invoices:create' }, idempotent: 'required',
  body: z.object({ customerId: uuid, hourlyRate: decimalInput, from: date, to: date, projectId: uuid.optional(), currency: currencyCode.optional(), taxIds: z.array(uuid).max(3).default([]) }),
  response: obj, audit: { action: 'invoice.created_from_timesheets', resourceType: 'invoice' },
  async handler(c) {
    const cust = await c.trx('billing_customers').where({ id: c.body.customerId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!cust) throw new AppError('VALIDATION_FAILED', 'Customer not found', [{ field: 'customerId', issue: 'not_found' }]);
    const q = c.trx('time_entries as e').join('timesheets as t', 't.id', 'e.timesheet_id').leftJoin('projects as p', 'p.id', 'e.project_id')
      .where({ 'e.organization_id': c.orgId(), 'e.billable': true, 't.status': 'approved' }).whereNull('e.invoice_id')
      .whereBetween('e.work_date', [c.body.from, c.body.to]).forUpdate('e');
    if (c.body.projectId) q.where('e.project_id', c.body.projectId);
    const entries = await q.select('e.id', 'e.project_id', 'e.minutes', 'p.name as project_name');
    if (entries.length === 0) throw new AppError('CONFLICT', 'No approved, uninvoiced billable time in this range');
    const byProject = new Map<string, { name: string; minutes: number; ids: string[]; projectId: string | null }>();
    type Grp = { name: string; minutes: number; ids: string[]; projectId: string | null };
    for (const e of entries) {
      const k = e.project_id ?? 'none';
      const g: Grp = byProject.get(k) ?? { name: e.project_name ?? 'Unassigned work', minutes: 0, ids: [] as string[], projectId: e.project_id };
      g.minutes += e.minutes; g.ids.push(e.id); byProject.set(k, g);
    }
    const currency = c.body.currency ?? cust.currency;
    const lines: LineIn[] = [...byProject.values()].map((g) => ({
      description: `${g.name} — ${c.body.from} to ${c.body.to}`, quantity: D(g.minutes).div(60).toDecimalPlaces(4).toString(),
      unitPrice: c.body.hourlyRate, discountPct: 0, taxIds: c.body.taxIds, projectId: g.projectId,
    }));
    const id = newId();
    await c.trx('invoices').insert({
      id, organization_id: c.orgId(), customer_id: cust.id, currency, source: 'timesheet', created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    const t = await writeLines(c.trx, c.orgId(), id, currency, c.svc.now().toISOString().slice(0, 10), lines);
    await c.trx('invoices').where({ id }).update({ subtotal: t.subtotal, discount_total: t.discountTotal, tax_total: t.taxTotal, total: t.total, balance: t.total });
    await c.trx('time_entries').whereIn('id', entries.map((e) => e.id)).update({ invoice_id: id });
    await history(c.trx, c.orgId(), id, null, 'draft', c.auth!.userId, 'from timesheets');
    return { status: 201, data: await invoiceDto(c.trx, c.orgId(), await c.trx('invoices').where({ id }).first()) };
  },
});

/** Idempotent: only moves unpaid, past-due invoices; safe to run repeatedly. */
export async function markOverdueInvoices(svc: Services, today: string): Promise<number> {
  const due = await withPlatformScope(svc.db, 'invoice-overdue', (t) =>
    t('invoices').whereIn('status', ['sent', 'partially_paid']).where('due_date', '<', today).where('balance', '>', 0).select('id', 'organization_id', 'status', 'number', 'created_by'));
  for (const inv of due) {
    await withTenant(svc.db, { organizationId: inv.organization_id, userId: null }, async (trx) => {
      const n = await trx('invoices').where({ id: inv.id }).whereIn('status', ['sent', 'partially_paid']).update({ status: 'overdue', updated_at: svc.now() });
      if (n) {
        await history(trx, inv.organization_id, inv.id, inv.status, 'overdue', null, 'past due date');
        await svc.events.emit(trx, 'invoice.overdue', inv.organization_id, { invoiceId: inv.id, number: inv.number, createdBy: inv.created_by });
      }
    });
  }
  return due.length;
}

jobRegistrars.push((svc) => {
  svc.jobs.work('billing', async () => { await markOverdueInvoices(svc, svc.now().toISOString().slice(0, 10)); });
});

registerExportKind('invoices', {
  permission: 'invoices:read', formats: ['csv', 'xlsx', 'json'],
  async generate(_svc, trx, ctx) {
    const rows = await trx('invoices as i').join('billing_customers as c', 'c.id', 'i.customer_id').where('i.organization_id', ctx.organizationId)
      .orderBy('i.created_at', 'desc').select('i.number', 'c.name as customer', 'i.status', 'i.issue_date', 'i.due_date', 'i.currency', 'i.subtotal', 'i.tax_total', 'i.total', 'i.amount_paid', 'i.balance');
    return { rows, filename: 'invoices' };
  },
});

defineRoute({
  method: 'post', path: '/invoices/export', module: M, moduleFlag: FLAG, summary: 'Export invoices (async)',
  access: { permission: 'invoices:read' }, idempotent: true, body: z.object({ format: z.enum(['csv', 'xlsx', 'json']).default('csv') }), response: obj,
  audit: { action: 'invoice.exported', resourceType: 'invoice' },
  async handler(c) { return { status: 202, data: await requestExport(c, 'invoices', c.body.format) }; },
});

registerWidget({
  key: 'invoices.summary', title: 'Invoices', requiredPermission: 'invoices:read', requiredModuleFlag: FLAG,
  async query({ trx, organizationId }) {
    const r = await trx.raw(
      `SELECT status, count(*)::int AS n, coalesce(sum(balance),0)::text AS balance FROM invoices WHERE organization_id = ? GROUP BY status`, [organizationId]);
    return Object.fromEntries(r.rows.map((x: { status: string; n: number; balance: string }) => [x.status, { count: x.n, balance: x.balance }]));
  },
});

void round;
