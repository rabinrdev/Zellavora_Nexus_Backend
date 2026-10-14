# API conventions

Base path `/api/v1`. JSON in/out, UTF-8, ISO-8601 UTC timestamps, `YYYY-MM-DD` calendar dates. OpenAPI 3.1: `docs/openapi.json` (generated, `npm run openapi:gen`), Swagger UI at `/api/docs` outside production.

## Envelope

Success: `{ "data": …, "meta": { … } }` (`meta` only for lists). Binary endpoints (PDF/CSV/file) return the raw body.

Error (always this shape, never stack traces or SQL):

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed",
             "details": [{ "field": "body.email", "issue": "Invalid email" }], "requestId": "…" } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | missing/invalid/revoked credentials (also unknown accounts — no enumeration) |
| `FORBIDDEN` | 403 | authenticated but lacks permission (cross-tenant is **404**, not 403) |
| `NOT_FOUND` | 404 | missing, soft-deleted, other tenant, module disabled, or draft public content |
| `CONFLICT` | 409 | duplicate, invalid state transition, in-flight idempotency key |
| `PRECONDITION_FAILED` | 412 | `If-Match` / `rowVersion` mismatch |
| `VALIDATION_FAILED` | 422 | schema or business-rule violation |
| `IDEMPOTENCY_KEY_REUSED` | 422 | same key, different request |
| `RATE_LIMITED` | 429 | with `Retry-After` |
| `PLAN_LIMIT_EXCEEDED` | 402 | entitlement missing / limit reached / account restricted |
| `TENANT_SUSPENDED` | 403 | organization not active |
| `MAINTENANCE` | 503 | maintenance mode, with `Retry-After` |
| `INTERNAL` | 500 | unexpected; details only in logs/error tracker |

Every response has `X-Request-Id` (an inbound well-formed id is echoed; otherwise generated). The same id is `correlation_id` in logs, audit and security events (`GET /platform/diagnostics/:requestId`).

## Lists

* Cursor pagination by default: `?limit=` (default 25, max 100) `&cursor=`; response `meta: { limit, nextCursor }`.
* Offset mode where useful: `?page=&pageSize=` → `meta.total`.
* `?sort=name` / `?sort=-created_at` — whitelisted fields per resource, deterministic (tie-break on `id`).
* `?filter[status]=active` (comma list for IN) — whitelisted; `?q=` for search where supported.
* Unknown sort/filter fields → `422`.

## Mutations

* `Idempotency-Key` header: **required** for provisioning, sending invoices, recording/allocating payments, credit notes, reconcile, subscriptions; optional on other idempotent POSTs. Same key + same body → stored response replayed (`Idempotent-Replay: true`); different body → 422; in flight → 409. TTL 24 h.
* Optimistic concurrency: send `If-Match: <rowVersion>` or `rowVersion` in the body; mismatch → 412.
* Soft delete: `DELETE` hides; `POST …/:id/restore` restores; permanent removal only via `POST /retention/purge` (legal hold + window) or the retention job.
* Async operations return `202` with an id (`/exports/:id`, `/imports/:id`).

## Versioning

All routes are under `/api/v1`. When a version is deprecated (`api_version_policy`), responses carry `Deprecation: true` and `Sunset: <date>`. `GET /api/v1/meta/version` returns app version, git SHA and supported API versions.

## Auth

`Authorization: Bearer <access token>` or `Bearer nxk_…` API key. Public endpoints are marked `Public endpoint.` in OpenAPI. Tokens are never accepted in query strings.
