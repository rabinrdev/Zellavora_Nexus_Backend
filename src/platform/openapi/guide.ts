import { DEMO } from './shared.js';

/** The "Getting started" text rendered at the top of Swagger UI / Redoc (info.description). */
export function gettingStartedGuide(): string {
  return `
Zellavora Nexus is a multi-tenant work-management platform API. This page is generated from the same route
definitions that run the server, so it cannot drift from the real behavior. Base path: \`/api/v1\`.

# Getting started

## 1. Sign in and get a token
1. \`POST /auth/login\` (\`loginWithPassword\`) with \`{ "email", "password" }\`. Add \`organizationCode\` if the user belongs to several organizations.
2. If the user has MFA enabled and no \`mfaCode\` was sent, the call returns \`401\` with \`details[0] = { field: "mfaCode", issue: "mfa_required" }\`. Repeat the login with \`mfaCode\` (TOTP or a recovery code).
3. The response contains \`accessToken\` (valid **15 minutes**), \`refreshToken\`, \`expiresIn\`, \`organizationId\` and \`mfaSetupRequired\`. When \`mfaSetupRequired\` is \`true\` the session may only call \`beginMfaEnrolment\` / \`confirmMfaEnrolment\` / \`verifyMfaCode\`.
4. Send \`Authorization: Bearer <accessToken>\` on every call. In Swagger UI press **Authorize** and paste the token (without the word "Bearer"); the page remembers it.
5. When the access token expires (\`401 UNAUTHENTICATED\`), call \`POST /auth/refresh\` with the refresh token. **Refresh tokens rotate**: use the new one from the response and discard the old one. The refresh token travels in the JSON body (there is no cookie, so no CSRF token is needed). Re-using an old refresh token revokes the session.
6. \`POST /auth/logout\` revokes the current session; \`POST /auth/logout-all\` revokes all of the user's sessions.

## 2. Tenancy (organizations)
Every business endpoint works inside the user's **active organization**, which comes from the access token.
**Never send \`organizationId\`** on tenant routes — it is ignored. To work in another organization call \`POST /auth/switch-organization\`
and use the returned token. \`GET /me/organizations\` lists the organizations the user belongs to.

## 3. Permissions, 403 and 404
\`GET /me/permissions\` (\`getMyPermissions\`) returns the permission keys of the caller; use them to show or hide UI actions. Each operation
below shows its required permission in the **Access** table and in \`x-required-permission\`.
* Missing permission → \`403 FORBIDDEN\`.
* A record of **another organization** (or a soft-deleted one) → \`404 NOT_FOUND\`, never \`403\`, so existence is not leaked.
* A module that is switched off for the organization → \`404 NOT_FOUND\` (see \`x-feature-flag\`).

## 4. Lists: pagination, filtering, sorting
Every response carries \`errorMessage\` (empty on success), \`infoMessage\` and \`hasError\`; the payload is in \`data\`. List responses add \`"meta": { "limit", "nextCursor" }\`.
* **Cursor pagination (default):** \`?limit=25\` (1-100) then pass \`meta.nextCursor\` as \`?cursor=\`. \`nextCursor: null\` means the last page. Cursors are opaque.
* **Offset pagination:** \`?page=2&pageSize=25\` adds \`meta.total\`.
* **Sorting:** \`?sort=name\` or \`?sort=-created_at\`; the allowed fields are listed per operation. Order is stable (tie-break on id).
* **Filtering:** \`?filter[status]=active\` (comma separates alternatives); allowed fields are listed per operation. \`?q=\` is a text search where supported.
* Unknown sort/filter fields return \`422\`.

## 5. Writing data
* **Idempotency:** send an \`Idempotency-Key\` (any unique string up to 128 chars) on operations that list it. Same key and same body within 24 h replays the original response with \`Idempotent-Replay: true\`; same key with a different body is \`422 IDEMPOTENCY_KEY_REUSED\`; while the first request is still running you get \`409\`. Some operations (sending invoices, recording payments, provisioning…) **require** the key.
* **Optimistic concurrency:** resources with a \`rowVersion\` return it on read. Send it back as \`If-Match: "<rowVersion>"\` or in the body when updating; a stale value returns \`412 PRECONDITION_FAILED\` — reload and retry.
* **Soft delete:** \`DELETE\` hides a record and a \`restore\` operation brings it back; permanent removal is a separate, protected \`purge\`.
* **Long-running work** (exports, imports, report exports) returns \`202\` and an id; poll the matching \`get…ById\` operation until \`status\` is \`completed\` or \`failed\`.

## 6. Conventions
* **Errors:** always \`{ "errorMessage": [{ "id", "msg", "msgType": "Error", "code", "field?", "issue?" }], "infoMessage", "hasError": true, "requestId" }\`. The first \`errorMessage\` entry is the summary (branch on its \`code\`, see **ErrorCode**, and show \`msg\`); validation errors add one entry per field (\`field\`, \`issue\`) to map onto form fields. Quote \`requestId\` (also the \`X-Request-Id\` header) to support.
* **Rate limits:** \`429 RATE_LIMITED\` with a \`Retry-After\` header (seconds). Sensitive endpoints (login, invitations, search) have stricter buckets.
* **Dates and times:** ISO-8601 in UTC (\`${DEMO.timestamp}\`); calendar dates are \`YYYY-MM-DD\`.
* **Money:** decimal **strings** (\`"1250.00"\`) plus an ISO-4217 \`currency\`; never floats.
* **Identifiers:** UUIDs. Resource keys such as report keys or lookup types are lowercase strings.
* **Files:** upload with \`multipart/form-data\` (\`uploadFile\` / \`uploadDocument\`), then reference the returned \`id\`. Download with \`getFileDownloadLink\` (short-lived signed URL) or stream via \`downloadFile\`. Files are virus-scanned; infected files cannot be downloaded.
* **Versioning:** the version is in the path (\`/api/v1\`). Deprecated versions answer with \`Deprecation: true\` and a \`Sunset\` date header; \`GET /meta/version\` lists the versions served.
* **Maintenance mode:** \`503 MAINTENANCE\` with \`Retry-After\`; health and version endpoints stay available.
* **Webhooks:** outbound events and their signature scheme are in the **webhooks** section of this document.

## 7. Where to report problems
Send the \`requestId\` of the failing call, the operation id and the time to the platform support contact of your deployment
(see the \`contact\` field of this document).
`.trim();
}
