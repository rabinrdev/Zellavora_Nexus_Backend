import './zod-extend.js';
import { z } from 'zod';

/** One consistent demo tenant/user/project across every example in the spec. */
export const DEMO = {
  organizationId: '0c8f6a52-5d1e-4b0c-9a4e-1f2d3c4b5a69',
  userId: '5e0f6a52-7d1e-4b0c-9a4e-1f2d3c4b5a11',
  projectId: '7a1b6a52-5d1e-4b0c-9a4e-1f2d3c4b5a22',
  taskId: '9b2c6a52-5d1e-4b0c-9a4e-1f2d3c4b5a33',
  invoiceId: '3d4e6a52-5d1e-4b0c-9a4e-1f2d3c4b5a44',
  requestId: 'req_7f3a9c2e41b84d6e',
  email: 'amelia.hart@example.test',
  timestamp: '2026-03-02T09:30:00.000Z',
  date: '2026-03-02',
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.EXAMPLE.EXAMPLE',
} as const;

/** Machine-readable error codes (src/platform/errors.ts) with the status they map to and advice for the UI. */
export const ERROR_CODES: { code: string; status: number; meaning: string; frontend: string }[] = [
  { code: 'UNAUTHENTICATED', status: 401, meaning: 'Missing, expired or revoked credentials.', frontend: 'Try POST /auth/refresh once; if that fails send the user to the sign-in screen.' },
  { code: 'FORBIDDEN', status: 403, meaning: 'Authenticated but not allowed (missing permission, read-only support session, no active organization).', frontend: 'Hide the action using GET /me/permissions; show a "you do not have access" message.' },
  { code: 'TENANT_SUSPENDED', status: 403, meaning: 'The active organization is suspended.', frontend: 'Show a suspended-organization screen; only platform admins can reactivate.' },
  { code: 'NOT_FOUND', status: 404, meaning: 'Resource does not exist, belongs to another organization, or its module is disabled.', frontend: 'Show a not-found state. Never retry.' },
  { code: 'CONFLICT', status: 409, meaning: 'Uniqueness or state conflict, or a request with the same Idempotency-Key is still running.', frontend: 'Show the message; for in-flight idempotency retry after a short delay with the same key.' },
  { code: 'PRECONDITION_FAILED', status: 412, meaning: 'If-Match / rowVersion is missing or stale: someone else changed the record.', frontend: 'Reload the record, show a merge/overwrite prompt, resend with the new rowVersion.' },
  { code: 'VALIDATION_FAILED', status: 422, meaning: 'Body, query or path parameters failed validation; `details` lists each field.', frontend: 'Map `details[].field` to form fields and show `details[].issue` inline.' },
  { code: 'IDEMPOTENCY_KEY_REUSED', status: 422, meaning: 'The Idempotency-Key was already used with a different request.', frontend: 'Generate a new key per distinct operation.' },
  { code: 'PLAN_LIMIT_EXCEEDED', status: 402, meaning: 'The subscription plan does not include this feature or its quota is exhausted.', frontend: 'Show an upgrade prompt using GET /entitlements/{entitlementKey}.' },
  { code: 'RATE_LIMITED', status: 429, meaning: 'Too many requests; `Retry-After` gives the seconds to wait.', frontend: 'Back off for Retry-After seconds, then retry.' },
  { code: 'MAINTENANCE', status: 503, meaning: 'The service is in maintenance mode; `Retry-After` is set.', frontend: 'Show a maintenance banner and poll GET /health/ready.' },
  { code: 'INTERNAL', status: 500, meaning: 'Unexpected server error. `requestId` identifies it in the logs.', frontend: 'Show a generic error with the requestId so support can trace it.' },
];

export const ErrorCodeSchema = z.enum(ERROR_CODES.map((e) => e.code) as [string, ...string[]]).openapi({
  description: ['Machine-readable error code.', ...ERROR_CODES.map((e) => `- \`${e.code}\` (${e.status}): ${e.meaning} **UI:** ${e.frontend}`)].join('\n'),
  example: 'NOT_FOUND',
});

const errorMessage = z.object({
  id: z.number().int().openapi({ description: 'Message id (0 for API errors).', example: 0 }),
  msg: z.string().openapi({ description: 'Human-readable text, safe to show to end users. Validation entries read `field: issue`.', example: 'Resource not found' }),
  msgType: z.literal('Error').openapi({ example: 'Error' }),
  code: ErrorCodeSchema,
  field: z.string().optional().openapi({ description: 'Dotted path of the offending input, e.g. `body.name`. Validation entries only.', example: 'body.name' }),
  issue: z.string().optional().openapi({ description: 'What is wrong with that input. Validation entries only.', example: 'Too small: expected string to have >=2 characters' }),
});

export const InfoMessageSchema = z.object({
  id: z.number().int().openapi({ example: 0 }),
  msg: z.string().nullable().openapi({ description: 'Optional informational text for the user; `null` when there is none.', example: null }),
  msgType: z.literal('Information').openapi({ example: 'Information' }),
});

/** Members present on every success and error response. */
export const statusFields = {
  errorMessage: z.array(errorMessage).openapi({ description: 'Empty on success. On errors the first entry is the summary, followed by one entry per invalid field.' }),
  infoMessage: InfoMessageSchema,
  hasError: z.boolean().openapi({ description: '`true` for every non-2xx response.', example: false }),
};

export const ErrorResponseSchema = z.object({
  ...statusFields,
  hasError: z.literal(true).openapi({ example: true }),
  requestId: z.string().openapi({ description: 'Correlation id, also returned in the `X-Request-Id` header.', example: DEMO.requestId }),
}).openapi({ description: 'Envelope returned by every non-2xx response. Branch on `errorMessage[0].code`.' });

export const ValidationErrorResponseSchema = ErrorResponseSchema.openapi({
  description: 'Returned with status 422 when input validation fails. `errorMessage[0].code` is `VALIDATION_FAILED` (or `IDEMPOTENCY_KEY_REUSED`); one further entry per field problem carries `field` and `issue`.',
  example: {
    errorMessage: [
      { id: 0, msg: 'Request validation failed', msgType: 'Error', code: 'VALIDATION_FAILED' },
      { id: 0, msg: 'body.name: Too small: expected string to have >=2 characters', msgType: 'Error', code: 'VALIDATION_FAILED', field: 'body.name', issue: 'Too small: expected string to have >=2 characters' },
    ],
    infoMessage: { id: 0, msg: null, msgType: 'Information' },
    hasError: true,
    requestId: DEMO.requestId,
  },
});

export const PaginationMetaSchema = z.object({
  limit: z.number().int().openapi({ description: 'Page size that was applied.', example: 25 }),
  nextCursor: z.string().nullable().openapi({ description: 'Opaque cursor for the next page, `null` on the last page. Pass it back as `cursor`.', example: 'eyJ2IjoiQWNtZSIsImlkIjoiMTIzIn0' }),
  total: z.number().int().optional().openapi({ description: 'Total matching rows. Only present with offset pagination (`page`).', example: 128 }),
  page: z.number().int().optional().openapi({ description: 'Current page (offset pagination only).', example: 1 }),
  pageSize: z.number().int().optional().openapi({ description: 'Page size (offset pagination only).', example: 25 }),
}).openapi({ description: 'Pagination information returned with every list response.' });

/** Envelope for single resources: `{ errorMessage, infoMessage, hasError, data: T }`. */
export const envelope = <T extends z.ZodType>(data: T) => z.object({ ...statusFields, data });
/** Envelope for lists: `{ data: T[], meta: PaginationMeta }`. */
export const paginated = <T extends z.ZodType>(item: T) => z.object({ ...statusFields, data: z.array(item), meta: PaginationMetaSchema });
