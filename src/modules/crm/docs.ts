import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';

documentRoutes({
  convertLead: {
    successStatus: 200, errors: [409], response: z.object({ customerId: uuid.describe('Billing customer created.'), contactId: uuid.describe('Contact created.'), leadId: uuid.describe('Converted lead.') }),
    description: 'Turns a lead into a client: creates a billing customer and a contact and marks the lead converted. A lead can be converted once (`409`). `Idempotency-Key` is supported.',
  },
  createClientActivity: {
    successStatus: 201, response: z.object({ customerId: uuid.describe('Client.'), kind: z.enum(['note', 'call', 'meeting', 'email']).describe('Activity type.') }),
    description: 'Logs a note, call, meeting or email on the client timeline. The client is a billing customer id.',
  },
  getClientHistory: {
    response: z.object({
      customerId: uuid.describe('Client.'), name: z.string().describe('Client name.'),
      timeline: z.array(z.object({ at: isoDate.nullable().describe('When it happened.'), type: z.string().describe('`note`, `call`, `meeting`, `email`, `invoice` or `enquiry`.'), summary: z.string().describe('One-line description.') })).describe('Newest first.'),
    }),
    responseName: 'ClientHistory', description: 'Timeline combining activities, enquiries and non-draft invoices of one client.',
  },
  inviteClientPortalAccount: {
    successStatus: 201, response: z.object({ id: uuid.describe('Portal account id.'), email: z.string().email().describe('Invited contact.'), status: z.literal('invited').describe('Initial status.') }),
    description: 'Mails a setup token to a client contact so they can use the client portal (`setPortalPassword`).',
  },
  setPortalPassword: { successStatus: 200, response: z.object({ message: z.string().describe('Confirmation.') }), description: 'Activates a portal account with the emailed token and a new password.' },
  loginToPortal: {
    successStatus: 200, errors: [401], response: z.object({ accessToken: z.string().describe('Portal access token; use as `Authorization: Bearer` (scheme `portalAuth`).'), expiresIn: z.number().int().describe('Lifetime in seconds.') }),
    description: 'Signs a client contact in. Repeated failures lock the account temporarily.',
  },
  listMyPortalInvoices: {
    collection: true, responseName: 'PortalInvoice',
    response: z.object({ id: uuid.describe('Invoice id.'), number: z.string().nullable().describe('Invoice number.'), status: z.string().describe('Status.'), total: z.string().describe('Total (decimal string).'), balance: z.string().describe('Open balance (decimal string).'), currency: z.string().describe('Currency.'), dueDate: z.string().nullable().describe('Due date.') }),
    description: 'Sent, partially paid, paid and overdue invoices of the signed-in client only. Requires a portal token.',
  },
  listMyPortalEnquiries: {
    collection: true, responseName: 'PortalEnquiry',
    response: z.object({ id: uuid.describe('Enquiry id.'), subject: z.string().describe('Subject.'), status: z.string().describe('Status.'), createdAt: isoDate.describe('Created at.') }),
    description: 'Enquiries of the signed-in client. Requires a portal token.',
  },
  createMyPortalEnquiry: { successStatus: 201, response: z.object({ id: uuid.describe('Enquiry id.') }), description: 'Submits an enquiry to the organization. Requires a portal token; rate limited.' },
  listMyPortalDocuments: {
    collection: true, responseName: 'PortalDocument',
    response: z.object({ id: uuid.describe('Document id.'), title: z.string().describe('Title.'), filename: z.string().describe('File name.'), contentType: z.string().describe('MIME type.'), size: z.number().int().describe('Bytes.') }),
    description: 'Clean documents shared with the client. Requires a portal token.',
  },
});
