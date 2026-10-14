# API naming convention

* **operationId**: camelCase `verbNoun`, globally unique, verb from `OPERATION_VERBS` (`src/platform/openapi/naming.ts`): `list`, `get`, `create`, `update`, `replace`, `delete`, `restore`, `purge`, `search`, `export`, `import` plus domain verbs (`send`, `void`, `approve`, `submit`, `publish`, `suspend`, …). Qualifiers disambiguate: `listProjectTasks`, `getMyPermissions`, `getInvoicePdf`.
* The operationId is the SDK method name and the key in `src/platform/openapi/operations.ts` (`"METHOD /path"` → operationId).
* **Paths**: `/api/v1`, plural kebab-case nouns, at most two levels, descriptive parameters (`{projectId}`, never `{id}`); actions are `POST` sub-resources (`/invoices/{invoiceId}/send`); the caller's own data is `/me/...`; the active tenant is implicit (never send `organizationId`).
* **Schemas**: PascalCase, `…Request`, `…Response`, `…ListResponse`, enums as nouns; no `Dto/Model/Data/Obj`.
* **Tags**: one human-named tag per module (`src/platform/openapi/catalog.ts`), grouped by `x-tagGroups`.
* Adding a route: register it with `defineRoute`, add its operationId to `operations.ts`, add a `documentRoutes` entry in the module's `docs.ts`, run `npm run docs:build`. `npm run docs:check` and the tests fail otherwise.
