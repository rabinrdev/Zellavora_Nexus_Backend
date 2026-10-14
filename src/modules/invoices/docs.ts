import { z } from 'zod';
import { documentRoutes, uuid, decimal } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const invoice = rowOf('invoices', {
  describe: {
    number: 'Gap-free invoice number, assigned when the invoice is sent; `null` for drafts.',
    status: '`draft`, `sent`, `partially_paid`, `paid`, `overdue` or `void`.', currency: 'ISO-4217 currency.',
    subtotal: 'Sum of line amounts before tax.', total: 'Amount due including tax.', balance: 'Unpaid amount.',
  },
});
const invoiceDetail = invoice.extend({ lines: z.array(rowOf('invoice_lines')).describe('Invoice lines in order.') });
const payment = rowOf('payments', { describe: { unallocated: 'Part of the payment not yet applied to invoices.', reference: 'Bank reference; used by reconciliation (matches an invoice number).' } });
const money = decimal;

documentRoutes({
  replaceNumberingRule: {
    successStatus: 200, response: z.object({ series: z.string().describe('Series key, e.g. `invoice`.'), prefix: z.string().describe('Number prefix.'), padding: z.number().int().describe('Zero padding width.'), resetYearly: z.boolean().describe('Restart numbering every year.') }),
    description: 'Configures a numbering series. Numbers are assigned gap-free when an invoice is sent.',
  },
  listNumberingRules: { response: rowOf('numbering_sequences'), responseName: 'NumberingSequence', collection: true, description: 'Current counters per series and period.' },
  createInvoice: {
    successStatus: 201, response: invoiceDetail, responseName: 'InvoiceDetail',
    requestExamples: {
      invoiceWithTax: { customerId: '3d4e6a52-5d1e-4b0c-9a4e-1f2d3c4b5a44', currency: 'USD', lines: [{ description: 'Website design', quantity: '10', unitPrice: '100.00' }] },
    },
    description: 'Creates a **draft**. Totals, tax and balance are computed on the server with decimal arithmetic; send quantities and prices as decimal strings. `Idempotency-Key` is supported.',
  },
  listInvoices: {
    response: invoice, responseName: 'Invoice', list: { sortable: ['created_at', 'issue_date', 'due_date', 'total'], filterable: ['status', 'customer_id'], defaultSort: '-created_at', searchable: false },
    description: 'Invoices of the organization. Extra filter: `customerId`.',
  },
  getInvoiceById: { response: invoiceDetail.extend({ history: z.array(rowOf('invoice_status_history')).describe('Status changes.') }), responseName: 'InvoiceDetailWithHistory', description: 'Invoice with lines and status history.' },
  updateInvoice: { successStatus: 200, response: invoiceDetail, responseName: 'InvoiceDetail', errors: [409, 412], description: 'Edits a **draft** invoice only (`409` once sent). Supplying `lines` replaces all lines; totals are recomputed.' },
  deleteInvoice: { successStatus: 204, errors: [409], description: 'Deletes a draft invoice. Sent invoices must be voided instead (`409`).' },
  sendInvoice: {
    successStatus: 200, response: z.object({ id: uuid.describe('Invoice id.'), number: z.string().describe('Newly assigned gap-free number.'), status: z.literal('sent').describe('New status.') }),
    errors: [409], description: 'Issues the invoice: assigns the number, freezes the lines and emails the customer. `Idempotency-Key` is **supported** and recommended.',
  },
  voidInvoice: { successStatus: 200, response: z.object({ id: uuid.describe('Invoice id.'), status: z.literal('void').describe('New status.') }), errors: [409], description: 'Voids an invoice that has no payments. A reason is mandatory.' },
  getInvoicePdf: { description: 'Renders the invoice as a PDF (`application/pdf`, attachment).' },
  recordPayment: {
    successStatus: 201, response: payment, responseName: 'Payment', errors: [409],
    description: 'Records a payment received from a customer and optionally allocates it to invoices in the same call. **`Idempotency-Key` is required.**',
  },
  allocatePayment: { successStatus: 200, response: payment, responseName: 'Payment', errors: [409], description: 'Allocates (part of) an unallocated payment to invoices. **`Idempotency-Key` is required.** Over-allocation returns `409`.' },
  listPayments: { response: payment, responseName: 'Payment', list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false }, description: 'Payments, newest first.' },
  reconcilePayments: {
    successStatus: 200,
    response: z.object({ matches: z.array(z.object({ paymentId: uuid.describe('Payment.'), invoiceId: uuid.describe('Matched invoice.'), invoiceNumber: z.string().describe('Invoice number equal to the payment reference.'), amount: money, applied: z.boolean().describe('`true` when `apply` was set and the allocation was made.') })).describe('Exact matches of payment reference, amount and currency.') }),
    description: 'Finds unallocated payments whose reference equals an open invoice number with exactly the same balance. `apply=false` (default) only reports. **`Idempotency-Key` is required.**',
  },
  issueCreditNote: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Credit note id.'), number: z.string().describe('Credit note number.'), invoiceId: uuid.describe('Invoice credited.'), amount: money, invoiceBalance: money }),
    errors: [409], description: 'Reduces the balance of a sent invoice. The credit cannot exceed the open balance (`409`). **`Idempotency-Key` is required.**',
  },
  listCreditNotes: { response: rowOf('credit_notes'), responseName: 'CreditNote', list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false }, description: 'Credit notes.' },
  getReceivablesSummary: {
    response: z.object({
      currency: z.string().describe('Currency summarized.'),
      buckets: z.object({ '0-30': money, '31-60': money, '61-90': money, '90+': money }).describe('Open balance by days overdue.'),
      total: money, invoices: z.number().int().describe('Open invoices counted.'),
    }),
    responseName: 'ReceivablesSummary', description: 'Aging buckets of open balances in one currency (query `currency`, default USD).',
  },
  createInvoiceFromTimesheets: {
    successStatus: 201, response: invoiceDetail, responseName: 'InvoiceDetail',
    description: 'Builds a draft from **approved billable** time entries between `from` and `to` at `hourlyRate`. Entries already invoiced are not billed twice. `Idempotency-Key` is supported.',
  },
  exportInvoices: {
    successStatus: 202, asyncJob: true, response: z.object({ id: uuid.describe('Export id; poll `getExportById`.'), kind: z.string().describe('`invoices`.'), format: z.string().describe('Format.'), status: z.string().describe('`pending`.') }),
    description: 'Queues an invoice export.',
  },
});
