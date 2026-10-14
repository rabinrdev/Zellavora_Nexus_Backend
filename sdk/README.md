# @zellavora/nexus-api-client

Typed client for the Zellavora Nexus API. **Every OpenAPI `operationId` is a method**, so the spec, the guide and your code share one vocabulary.

```ts
import { createApi } from '@zellavora/nexus-api-client';

const api = createApi({
  baseUrl: 'https://api.example.com',
  getTokens: () => session.tokens,          // { accessToken, refreshToken } | null
  onTokens: (t) => (session.tokens = t),    // called after login / refresh / switchOrganization
  onAuthLost: () => router.push('/login'),  // refresh token rejected
});

const login = await api.loginWithPassword({ body: { email, password } });
const me = await api.getMyPermissions();
const page = await api.listProjects({ query: { limit: 25, sort: 'name' } });
const task = await api.createProjectTask({ path: { projectId }, body: { title: 'Draft copy' } });
const sent = await api.sendInvoice({ path: { invoiceId }, header: { 'Idempotency-Key': crypto.randomUUID() } });
if (sent.error) console.log(sent.error.error.code, sent.error.error.requestId);
```

* Results are `{ data, error, response }`. `data` is the success envelope (`{ data, meta? }`); `error` is `{ error: { code, message, details, requestId } }`.
* The access token is attached automatically. A `401` triggers **one** shared `refreshAccessToken` call (refresh tokens rotate) and a single retry; if that fails `onAuthLost` runs.
* File uploads: pass a `FormData` as `body` (`uploadFile`, `uploadDocument`, `importRecords`).

## Regenerate

```
npm run generate   # types/api.d.ts from ../docs/openapi.yaml + client/operations.generated.ts
npm run build
```

The package version follows the API version (`info.version` of the spec).
