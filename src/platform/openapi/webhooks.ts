import { DEMO } from './shared.js';

type Json = Record<string, unknown>;

/** Event types documented in the OpenAPI `webhooks` section (a stable subset; the full catalog is `listWebhookEventCatalog`). */
const EVENTS: { type: string; summary: string; data: Json }[] = [
  { type: 'invoice.sent', summary: 'An invoice was issued to the customer', data: { id: DEMO.invoiceId, number: 'INV-2026-0001', total: '1250.00', currency: 'USD' } },
  { type: 'invoice.overdue', summary: 'An invoice passed its due date unpaid', data: { id: DEMO.invoiceId, number: 'INV-2026-0001', dueDate: DEMO.date } },
  { type: 'payment.recorded', summary: 'A payment was recorded', data: { id: '8e7d6c5b-4a39-4281-9f10-aabbccddeeff', amount: '1250.00', currency: 'USD' } },
  { type: 'approval.requested', summary: 'An approval request needs a decision', data: { id: '1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b', templateKey: 'expense' } },
  { type: 'approval.approved', summary: 'An approval request was approved', data: { id: '1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b', status: 'approved' } },
  { type: 'approval.rejected', summary: 'An approval request was rejected', data: { id: '1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b', status: 'rejected' } },
  { type: 'task.created', summary: 'A task was created', data: { id: DEMO.taskId, projectId: DEMO.projectId } },
  { type: 'task.assigned', summary: 'A task was assigned', data: { id: DEMO.taskId, assigneeId: DEMO.userId } },
  { type: 'task.status_changed', summary: 'A task changed status', data: { id: DEMO.taskId, from: 'todo', to: 'in_progress' } },
  { type: 'timesheet.submitted', summary: 'A timesheet was submitted for approval', data: { id: '2a3b4c5d-6e7f-4a1b-8c9d-0e1f2a3b4c5d' } },
  { type: 'timesheet.approved', summary: 'A timesheet was approved', data: { id: '2a3b4c5d-6e7f-4a1b-8c9d-0e1f2a3b4c5d' } },
  { type: 'user.removed', summary: 'A member was removed from the organization', data: { id: DEMO.userId } },
  { type: 'file.uploaded', summary: 'A file was uploaded', data: { id: '6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d', filename: 'brief.pdf' } },
];

/**
 * OpenAPI 3.1 `webhooks`: outbound events. Returned as plain path-item objects (not Zod) so that the
 * generator does not need them registered; schemas are expressed inline.
 */
export function webhookDefinitions(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of EVENTS) {
    const body = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', type: e.type, createdAt: DEMO.timestamp, data: e.data };
    out[e.type] = {
      post: {
        operationId: `receive${e.type.replace(/(^|[._])(\w)/g, (_m, _p, c: string) => c.toUpperCase())}Event`,
        summary: e.summary,
        description: [
          `Delivered to every active endpoint subscribed to \`${e.type}\` (or \`*\`). Respond with any **2xx within 10 seconds**.`,
          '',
          '**Headers**',
          '- `X-Nexus-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret>`. During secret rotation two space-separated signatures are sent; accept either. Reject timestamps older than 5 minutes.',
          '- `X-Nexus-Event`: event type · `X-Nexus-Delivery`: delivery id · `User-Agent: Zellavora-Nexus-Webhooks/1`.',
          '',
          '**Retries**: up to 6 attempts with back-off of 30 s, 2 min, 10 min, 1 h, 6 h; then the delivery is `dead`. After 20 consecutive failures the endpoint is auto-disabled. Redirects are not followed; non-HTTPS URLs are rejected in production.',
          '',
          '**Replay**: `replayWebhookEvent` re-sends a stored event to the current endpoints, and `retryWebhookDelivery` retries a failed/dead delivery. The event `id` stays the same.',
        ].join('\n'),
        tags: ['Integrations & Webhooks'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: webhookSchema(), example: body } },
        },
        responses: { '200': { description: 'Acknowledged. Any 2xx counts as delivered.' } },
      },
    };
  }
  return out;
}

function webhookSchema(): Json {
  return {
    type: 'object',
    required: ['id', 'type', 'createdAt', 'data'],
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Event id; identical across retries and replays, use it for de-duplication.' },
      type: { type: 'string', description: 'Event type, e.g. `invoice.sent`.' },
      createdAt: { type: 'string', format: 'date-time', description: 'When the event occurred (ISO-8601 UTC).' },
      data: { type: 'object', additionalProperties: true, description: 'Event-specific payload (shape shown in the example).' },
    },
  };
}
