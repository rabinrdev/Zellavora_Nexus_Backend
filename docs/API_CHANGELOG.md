# API changelog

## v1 (current, 1.0.0)
* Every operation has a unique `operationId`; path parameters named `:id` were renamed after their resource (see `API_RENAME_MAP.md`). Request/response bodies, status codes, permissions and validation are unchanged.
* Route move: `GET /help/articles/:slug` → `GET /help/articles/by-slug/{slug}`.
* Documentation endpoints: `/api/docs`, `/api/redoc`, `/api/docs/openapi.{json,yaml}`.
* New env: `APP_BASE_URL`, `DOCS_BASIC_AUTH_USER`, `DOCS_BASIC_AUTH_PASS`.

## Process for future versions
Breaking changes (removed/renamed paths or fields, tighter validation) need a new `/api/v2` section here, a `Deprecation`/`Sunset` plan for v1 and a regenerated spec (`npm run docs:build`).
