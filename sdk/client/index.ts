import createClient, { type Middleware } from 'openapi-fetch';
import type { paths, operations } from '../types/api.js';
import { OPERATIONS } from './operations.generated.js';

export type { paths, operations } from '../types/api.js';

/** Token pair kept by the application (memory/secure storage); the client asks for it and reports rotations. */
export interface Tokens { accessToken: string; refreshToken: string }

export interface ClientOptions {
  /** Origin of the API, e.g. `https://api.example.com` (paths already contain `/api/v1`). */
  baseUrl: string;
  getTokens(): Tokens | null | Promise<Tokens | null>;
  /** Called after a successful login/refresh/switch with the new pair. Persist it. */
  onTokens(tokens: Tokens): void | Promise<void>;
  /** Called when the refresh token is rejected: send the user to the sign-in screen. */
  onAuthLost(): void;
  fetch?: typeof fetch;
}

type Op<K extends keyof operations> = operations[K];
type PartOf<O, Key extends string> = O extends { parameters: infer P } ? (Key extends keyof P ? NonNullable<P[Key]> : never) : never;
type IsNever<T> = [T] extends [never] ? true : false;
type Json<R> = R extends { content: { 'application/json': infer B } } ? B : never;
type Success<O> = O extends { responses: infer R } ? { [S in keyof R & (200 | 201 | 202)]: Json<R[S]> }[keyof R & (200 | 201 | 202)] : never;
type Failure<O> = O extends { responses: infer R } ? Json<R[Exclude<keyof R, 200 | 201 | 202 | 204>]> : never;

/** Everything a call can take. Fields that the operation does not define are `never` and therefore omitted. */
export type Input<K extends keyof operations> = (IsNever<PartOf<Op<K>, 'path'>> extends true ? unknown : { path: PartOf<Op<K>, 'path'> })
  & (IsNever<PartOf<Op<K>, 'query'>> extends true ? unknown : { query?: PartOf<Op<K>, 'query'> })
  & (IsNever<PartOf<Op<K>, 'header'>> extends true ? unknown : { header?: PartOf<Op<K>, 'header'> })
  & (Op<K> extends { requestBody: { content: infer C } } ? { body: C[keyof C] } : unknown);

export interface Result<K extends keyof operations> {
  /** Parsed body of a 2xx response (`undefined` for 204 or errors). */
  data?: Success<Op<K>>;
  /** Error envelope `{ error: { code, message, details, requestId } }` for non-2xx responses. */
  error?: Failure<Op<K>>;
  response: Response;
}

export type Api = { [K in keyof operations]: (input?: Input<K>) => Promise<Result<K>> };


/**
 * Creates the API object. Every OpenAPI operationId is a method: `api.createProject({ body: { name: 'Website' } })`.
 * Adds the bearer token and refreshes it once (single flight) when a call answers 401.
 */
export function createApi(opts: ClientOptions): Api {
  const f = opts.fetch ?? fetch;
  const client = createClient<paths>({ baseUrl: opts.baseUrl, fetch: (req) => f(req) });
  const retryable = new WeakMap<Request, Request>();
  let refreshing: Promise<Tokens | null> | null = null;

  const refresh = async (): Promise<Tokens | null> => {
    const current = await opts.getTokens();
    if (!current) return null;
    const res = await client.POST('/api/v1/auth/refresh', { body: { refreshToken: current.refreshToken } });
    const data = (res.data as { data?: { accessToken: string; refreshToken: string } } | undefined)?.data;
    if (!data) return null;
    const next = { accessToken: data.accessToken, refreshToken: data.refreshToken };
    await opts.onTokens(next);
    return next;
  };

  const auth: Middleware = {
    async onRequest({ request }) {
      retryable.set(request, request.clone());
      const t = await opts.getTokens();
      if (t && !request.headers.has('authorization')) request.headers.set('authorization', `Bearer ${t.accessToken}`);
      return request;
    },
    async onResponse({ request, response }) {
      if (response.status !== 401 || request.url.endsWith('/auth/refresh')) return response;
      const original = retryable.get(request);
      if (!original || !(await opts.getTokens())) return response;
      refreshing ??= refresh().finally(() => { refreshing = null; });
      const next = await refreshing;
      if (!next) {
        opts.onAuthLost();
        return response;
      }
      const retry = new Request(original, { headers: new Headers(original.headers) });
      retry.headers.set('authorization', `Bearer ${next.accessToken}`);
      return f(retry);
    },
  };
  client.use(auth);

  const api = {} as Record<string, unknown>;
  for (const [operationId, { method, path }] of Object.entries(OPERATIONS)) {
    api[operationId] = async (input: { path?: Record<string, unknown>; query?: unknown; header?: unknown; body?: unknown } = {}) => {
      const isMultipart = typeof FormData !== 'undefined' && input.body instanceof FormData;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (client as any).request(method.toUpperCase(), path, {
        params: { path: input.path, query: input.query, header: input.header },
        body: input.body,
        ...(isMultipart ? { bodySerializer: (b: unknown) => b } : {}),
      });
      const tokens = (res.data as { data?: { accessToken?: string; refreshToken?: string } } | undefined)?.data;
      if ((operationId === 'loginWithPassword' || operationId === 'switchOrganization') && tokens?.accessToken && tokens.refreshToken) {
        await opts.onTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      }
      return res;
    };
  }
  return api as Api;
}
