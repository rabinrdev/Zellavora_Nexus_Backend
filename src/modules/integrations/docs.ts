import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const endpoint = rowOf('webhook_endpoints', {
  hide: ['secret_encrypted', 'previous_secret_encrypted', 'previous_secret_expires_at'],
  describe: { url: 'HTTPS URL events are POSTed to.', eventTypes: 'Subscribed event types; `*` = all.', status: '`active` or `disabled`.', consecutiveFailures: 'Failures in a row; 20 disables the endpoint.' },
});
const acceptedId = z.object({ id: uuid.describe('Delivery id.'), status: z.literal('pending').describe('Queued for sending.') });

documentRoutes({
  listWebhookEventCatalog: { response: z.string().describe('Event type, e.g. `invoice.sent`.'), responseName: 'WebhookEventType', collection: true, description: 'Event types that can be subscribed to. Payload shapes are in the **webhooks** section of this document.' },
  createWebhookEndpoint: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Endpoint id.'), url: z.string().describe('Target URL.'), eventTypes: z.array(z.string()).describe('Subscribed events.'), secret: z.string().describe('Signing secret `whsec_…`. **Shown once.** Use it to verify `X-Nexus-Signature`.') }),
    description: 'Registers an endpoint. The URL is checked against SSRF rules (HTTPS in production, no private addresses).',
  },
  listWebhookEndpoints: { response: endpoint, responseName: 'WebhookEndpoint', collection: true, description: 'Endpoints of the organization; secrets are never returned.' },
  updateWebhookEndpoint: { successStatus: 200, response: endpoint, responseName: 'WebhookEndpoint', description: 'Changes URL, subscribed events or status (re-enabling resets the failure counter).' },
  deleteWebhookEndpoint: { successStatus: 204, description: 'Deletes the endpoint and stops deliveries.' },
  rotateWebhookEndpointSecret: {
    successStatus: 200, response: z.object({ id: uuid.describe('Endpoint id.'), secret: z.string().describe('New secret. **Shown once.**'), previousSecretValidForMinutes: z.number().int().describe('Both signatures are sent during this overlap window.') }),
    description: 'Issues a new signing secret; deliveries carry signatures for both secrets until the overlap ends.',
  },
  testWebhookEndpoint: { successStatus: 202, response: z.object({ deliveryId: uuid.describe('Test delivery; see `listWebhookDeliveries`.') }), description: 'Queues a test ping to the endpoint.' },
  listWebhookDeliveries: {
    response: rowOf('webhook_deliveries'), responseName: 'WebhookDelivery', list: { sortable: ['created_at'], filterable: ['status'], defaultSort: '-created_at', searchable: false },
    description: 'Delivery attempts. Extra filter: `endpointId`. Status: `pending`, `delivered`, `failed` (will retry) or `dead` (gave up after 6 attempts).',
  },
  listWebhookEvents: {
    response: rowOf('webhook_events'), responseName: 'WebhookEvent', list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false },
    description: 'Events that were captured for delivery.',
  },
  retryWebhookDelivery: { successStatus: 202, response: acceptedId, errors: [409], description: 'Retries a `failed` or `dead` delivery.' },
  replayWebhookEvent: {
    successStatus: 202, response: z.object({ eventId: uuid.describe('Replayed event.'), deliveries: z.array(uuid).describe('New deliveries created.') }),
    description: 'Re-sends a stored event to the current endpoints (the event id stays the same).',
  },
  replaceIntegrationConfiguration: {
    successStatus: 200,
    response: z.object({ provider: z.string().describe('Provider key.'), name: z.string().describe('Display name.'), keys: z.array(z.string()).describe('Names of the stored configuration keys (values are encrypted and never returned).'), status: z.string().describe('`active` or `disabled`.') }),
    description: 'Stores an encrypted configuration for a provider (for example SMTP or a storage connector).',
  },
  listIntegrations: {
    response: z.object({ id: uuid.describe('Integration id.'), provider: z.string().describe('Provider key.'), name: z.string().describe('Display name.'), status: z.string().describe('Status.'), config: z.record(z.string(), z.literal('********')).describe('Configuration keys with masked values.') }),
    responseName: 'Integration', collection: true, description: 'Configured integrations with every value masked.',
  },
});
