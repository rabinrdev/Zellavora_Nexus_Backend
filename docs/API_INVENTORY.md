# API inventory (Phase 0 audit, taken before the Swagger work)

**Stack:** Express 5.3, Zod 4, `@asteasolutions/zod-to-openapi` 9 (OpenAPI 3.1), `swagger-ui-express`. Routes were registered through `defineRoute()` into a central `routeRegistry` (plus `crudResource()` for CRUD tables); four probe/meta routes were mounted directly in `app.ts`. Validation: Zod on params/query/body, enforced in `defineRoute`. Error envelope `{ error: { code, message, details, requestId } }`. Auth: `authenticate()`; permissions via `access: { permission }`. Pagination: `paginate()` (cursor/offset). Idempotency and rate limit: built into `defineRoute`. Module flags: `moduleFlag`.

**State found:** a minimal generated spec (summary only, one generic `4XX/5XX` response, no operationIds, no examples, no tags catalog, `:id` path parameters), Swagger UI at `/api/docs`, no Redoc, no YAML.

| Measure | Count |
|---|---|
| Registry routes | 460 |
| Plus routes mounted in `app.ts` (health/live, health/ready, metrics, meta/version) | 4 |
| Routes with a Zod validation schema (params, query or body) | 408 (the other 52 take no input) |
| Routes whose documented response was a generic `Record<string, unknown>` (measured on the first generated spec) | 321 of 424 with a body |
| Routes with an operationId / request example / response example / description | 0 / 0 / 0 / 0 |
| Routes with `:id` path parameters | 232 |
| Routes with auto-generated or unclear summaries (`Get groups item`, `approve a request`, …) | all CRUD routes plus 13 others; now replaced |

The complete per-route table is `docs/API_ENDPOINT_INDEX.csv` (current names) and `docs/API_RENAME_MAP.md` (old → new).
