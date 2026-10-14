export type ErrorCode =
  | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_FAILED' | 'RATE_LIMITED'
  | 'IDEMPOTENCY_KEY_REUSED' | 'PRECONDITION_FAILED' | 'TENANT_SUSPENDED' | 'MAINTENANCE' | 'PLAN_LIMIT_EXCEEDED' | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, VALIDATION_FAILED: 422,
  RATE_LIMITED: 429, IDEMPOTENCY_KEY_REUSED: 422, PRECONDITION_FAILED: 412, TENANT_SUSPENDED: 403,
  MAINTENANCE: 503, PLAN_LIMIT_EXCEEDED: 402, INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: { field?: string; issue: string }[] = [],
  ) {
    super(message);
    this.status = STATUS[code];
  }
}
