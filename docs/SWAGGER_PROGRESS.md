# Swagger / OpenAPI progress and final report

**Status: complete.** Every one of the 464 mounted operations is in the generated spec with full request/response contracts; the gates below run in `npm run verify` (via `docs:check` and the test suite) and in CI.

## Phases
| Step | Result |
|---|---|
| 0 Audit | `docs/API_INVENTORY.md` |
| 1–2 Builder, shared components | `src/platform/openapi/*` (buildSpec, catalog, naming, operations, shared, examples, describe, rows, webhooks, external, serve, guide) |
| 3 Module sweep | all 28 registry modules documented in `src/modules/*/docs.ts` (auth, iam, organizations, settings, audit, dashboard, data, security, files, workflow, notifications, teams, projects, timesheets, approvals, invoices, search, billing, integrations, platform, help, crm, documents, cms/pagebuilder/themes/public, reporting) |
| 4 Webhooks, guides, audiences, env gating | webhooks section (13 events), Getting started guide, `?audience=full`, `SWAGGER`, Basic gate |
| 5 Gates | Spectral `.spectral.yaml`, `tests/openapi.gate.test.ts`, `tests/contract.e2e.test.ts`, `tests/helpers/doc-check.ts`, stale-artifact checks, CI |
| 6 Artifacts | Postman, `sdk/`, `FRONTEND_API_GUIDE.md`, `API_ENDPOINT_INDEX.csv`, `API_RENAME_MAP.md`, `API_CHANGELOG.md` |
| 7 Live proof | below |

## Live proof (real server, real database)
* Fetched `/api/docs/openapi.json?audience=full` from the running server; `/api/docs/`, `/api/redoc`, `/api/docs/openapi.json|yaml` all `200`.
* Operations per tag and method (live spec):

| Tag | GET | POST | PUT | PATCH | DELETE | Total |
|---|---|---|---|---|---|---|
| Authentication | 2 | 16 | 0 | 0 | 1 | 19 |
| Users & Access (IAM) | 14 | 12 | 2 | 3 | 5 | 36 |
| Organizations | 8 | 14 | 0 | 4 | 3 | 29 |
| Documents & Files | 13 | 6 | 2 | 2 | 3 | 26 |
| Settings | 8 | 1 | 1 | 5 | 0 | 15 |
| Data Lifecycle | 5 | 4 | 1 | 0 | 0 | 10 |
| Platform Operations (internal) | 14 | 13 | 3 | 0 | 1 | 31 |
| Audit Logs | 4 | 1 | 1 | 0 | 0 | 6 |
| Security & Privacy | 4 | 6 | 1 | 0 | 0 | 11 |
| Dashboard | 6 | 2 | 0 | 1 | 1 | 10 |
| Workflows | 4 | 7 | 1 | 0 | 0 | 12 |
| Teams | 6 | 3 | 3 | 1 | 2 | 15 |
| Projects & Tasks | 15 | 11 | 2 | 5 | 7 | 40 |
| Approvals | 4 | 9 | 1 | 0 | 1 | 15 |
| Timesheets | 6 | 7 | 0 | 1 | 1 | 15 |
| Notifications | 5 | 3 | 2 | 0 | 0 | 10 |
| Invoices & Payments | 11 | 12 | 1 | 3 | 3 | 30 |
| Clients & CRM | 9 | 11 | 0 | 4 | 4 | 28 |
| Client Portal | 3 | 3 | 0 | 0 | 0 | 6 |
| Content (CMS) | 11 | 15 | 0 | 3 | 3 | 32 |
| Page Builder | 2 | 0 | 2 | 0 | 0 | 4 |
| Themes | 2 | 2 | 1 | 1 | 1 | 7 |
| Public Site Delivery | 6 | 0 | 0 | 0 | 0 | 6 |
| Subscription & Billing | 4 | 6 | 0 | 0 | 0 | 10 |
| Integrations & Webhooks | 5 | 5 | 1 | 1 | 1 | 13 |
| Reports | 6 | 5 | 0 | 2 | 3 | 16 |
| Help & Support | 4 | 2 | 0 | 1 | 0 | 7 |
| Search | 1 | 0 | 0 | 0 | 0 | 1 |
| Health & Operations | 4 | 0 | 0 | 0 | 0 | 4 |
| **All** | 186 | 176 | 25 | 37 | 40 | **464** |

* Invariants (script `scripts/live-proof.ts`): operations = 460 registry routes + 4 probe/meta routes; 0 missing description/summary; 0 missing success example; 0 duplicate operationIds; 0 `{id}` paths.
* Coverage test output: `464 operations | descriptions 464/464 | summaries 464/464 | tags 464/464 | security 464/464 | request examples 187/187 | response examples 464/464 | error responses 464/464`.
* Browser (Playwright): Swagger UI loads with no console errors, Authorize dialog shows `bearerAuth`, `apiKeyAuth`, `portalAuth`; **Try it out** executed `loginWithPassword` (token returned) and then `getMyPermissions` with that token (`200`); Redoc renders with tag groups. Screenshots: `docs/screenshots/`.
* Newman smoke (3 requests: `getHealthLive`, `loginWithPassword` which stores the token, `getMyPermissions`): 3/3 requests, 1/1 assertions passed.
* SDK: `sdk` `tsc` compiles `client/usage.check.ts` (typed calls such as `api.createProject`, `api.listProjectTasks`, `api.sendInvoice`).
* Gate results at the end: `eslint` clean, `tsc` clean, Spectral 0 errors on both specs, 141/141 tests (13 files, real PostgreSQL).

## Defects found
1. The docs CSP (`connect-src 'self'`) blocked Try-it-out because the first spec server was `http://localhost:3000`. Fixed: first server is `/`.
2. Redoc 3 uses `import.meta` and does not load as a classic script. Fixed: pinned Redoc 2.5.0, versioned asset URL (an earlier 1-day cache had hidden the fix).
3. `GET /help/articles/:slug` and `PATCH /help/articles/:id` were the same URL shape (not expressible in OpenAPI). Fixed by moving the GET to `/help/articles/by-slug/{slug}` (test updated).
4. Observed-traffic check found undocumented statuses (login/accept 401, switch-organization 404, purge 404, several 409s); documented.
5. Request schemas listed fields with server defaults as required; spec now marks them optional (and the SDK generator uses `--default-non-nullable false`).

## Decisions
D-023 … D-031 in `docs/DECISIONS.md`.

## Needs human input / known limits
* `oasdiff` breaking-change detection is not wired (no binary available here).
* Statuses that no test exercises (e.g. rare 409s) come from handler source and explicit `errors` lists; they are best-effort (D-028).
* Several response schemas for dynamic payloads are intentionally open objects (settings values, widget `data`, report rows, block `props`); their shape is described per key in the operation description.
* `info.version` is `APP_VERSION` (default `0.1.0` in `src/config/env.ts`; committed artifacts are built as `1.0.0`). Set `APP_VERSION` in your deployment to keep them aligned.
* The project's `.env` currently points `DATABASE_URL`/SMTP at external services that were unreachable/rejecting during the live proof; the proof server used the local embedded PostgreSQL and `MAIL_DRIVER=console`.
* Dev-only tooling brings `npm audit` findings (Postman converter, Spectral); `npm audit --omit=dev` reports 0.
* Commit `1d07e29` also picked up `README.md`, `docker-compose.yml` and `docs/CONFIGURATION.md` changes that were already in the working tree before this task (not authored here); review them if unexpected.
