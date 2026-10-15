/**
 * Response envelope shared by every JSON endpoint.
 *
 * Success: `{ errorMessage: [], infoMessage: { id, msg, msgType: 'Information' }, hasError: false, data, meta? }`
 * Error:   `{ errorMessage: [{ id, msg, msgType: 'Error', code, field?, issue? }], infoMessage, hasError: true, requestId }`
 */
export interface ErrorMessage {
  id: number;
  msg: string;
  msgType: 'Error';
  /** Machine-readable error code (see ErrorCode). */
  code: string;
  /** Offending input (validation errors). */
  field?: string;
  issue?: string;
}

export interface InfoMessage {
  id: number;
  msg: string | null;
  msgType: 'Information';
}

export const noInfo = (): InfoMessage => ({ id: 0, msg: null, msgType: 'Information' });

export function successBody(data: unknown, opts: { meta?: Record<string, unknown>; message?: string } = {}) {
  return {
    errorMessage: [] as ErrorMessage[],
    infoMessage: opts.message ? { id: 0, msg: opts.message, msgType: 'Information' as const } : noInfo(),
    hasError: false,
    data: data ?? null,
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
}

/** First entry is the summary; validation problems follow as one entry per field. */
export function errorBody(code: string, message: string, details: { field?: string; issue: string }[], requestId: string) {
  const errorMessage: ErrorMessage[] = [{ id: 0, msg: message, msgType: 'Error', code }];
  for (const d of details) {
    errorMessage.push({ id: 0, msg: d.field ? `${d.field}: ${d.issue}` : d.issue, msgType: 'Error', code, ...(d.field ? { field: d.field } : {}), issue: d.issue });
  }
  return { errorMessage, infoMessage: noInfo(), hasError: true, requestId };
}
