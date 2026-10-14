import { DEMO } from './shared.js';

/** `maxAttempts` → "max attempts", `PLAN_LIMIT` → "plan limit". */
export function humanize(name: string): string {
  return name
    .replace(/\[|\]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const ID_EXAMPLES: Record<string, string> = {
  userId: DEMO.userId,
  projectId: DEMO.projectId,
  taskId: DEMO.taskId,
  invoiceId: DEMO.invoiceId,
  organizationId: DEMO.organizationId,
};
export const DEMO_UUID = '4c9d6a52-5d1e-4b0c-9a4e-1f2d3c4b5a55';

const KNOWN_PARAMS: Record<string, { d: string; e: unknown }> = {
  slug: { d: 'URL slug of the resource (lowercase letters, digits and hyphens).', e: 'getting-started' },
  orgSlug: { d: 'Public slug of the organization whose published content is requested.', e: 'acme-design' },
  token: { d: 'Opaque, time-limited token issued by the API (signed link or preview link).', e: 'dGhpcy1pcy1hbi1leGFtcGxlLXRva2Vu' },
  key: { d: 'Stable string key of the resource (for example a report, widget, flag or entitlement key).', e: 'tasks_by_status' },
  type: { d: 'Lookup type key (for example `industry` or `task_priority`).', e: 'task_priority' },
  resource: { d: 'Resource name the operation applies to (for example `projects`, `contacts`).', e: 'projects' },
  provider: { d: 'Provider key (for example the payment provider or integration name).', e: 'mock' },
  series: { d: 'Numbering series key (for example `invoice` or `credit_note`).', e: 'invoice' },
  kind: { d: 'Brand asset kind: `logo`, `favicon` or `banner`.', e: 'logo' },
  version: { d: 'Version number of the page or post (1-based).', e: 3 },
  requestId: { d: 'The `X-Request-Id` / `requestId` value to trace across audit and security logs.', e: DEMO.requestId },
};

/** Description for a path parameter, derived from its descriptive name. */
export function paramDescription(name: string): string {
  if (KNOWN_PARAMS[name]) return KNOWN_PARAMS[name]!.d;
  const m = /^(.+)Id\d?$/.exec(name);
  if (m) return `Unique identifier (UUID) of the ${humanize(m[1]!)}.`;
  return `The ${humanize(name)}.`;
}

export function paramExample(name: string): unknown {
  if (KNOWN_PARAMS[name]) return KNOWN_PARAMS[name]!.e;
  if (ID_EXAMPLES[name]) return ID_EXAMPLES[name];
  if (/Id\d?$/.test(name)) return DEMO_UUID;
  return 'example';
}

const PROPS: Record<string, string> = {
  id: 'Unique identifier (UUID).',
  organizationId: 'Identifier of the owning organization (server-derived).',
  createdAt: 'When the record was created (ISO-8601 UTC).',
  updatedAt: 'When the record was last changed (ISO-8601 UTC).',
  deletedAt: 'When the record was soft-deleted (ISO-8601 UTC); `null` while active.',
  createdBy: 'User id that created the record.',
  updatedBy: 'User id that last changed the record.',
  deletedBy: 'User id that deleted the record.',
  rowVersion: 'Optimistic-concurrency version; send it back as `rowVersion` or `If-Match` when updating.',
  name: 'Display name.',
  title: 'Title shown to users.',
  description: 'Free-text description.',
  email: 'Email address.',
  status: 'Current lifecycle status.',
  note: 'Optional free-text note.',
  comment: 'Optional free-text comment.',
  reason: 'Reason given for the action.',
  currency: 'ISO-4217 currency code, e.g. `USD`.',
  amount: 'Monetary amount as a decimal string.',
  password: 'The user\'s password.',
  currentPassword: 'The user\'s current password (re-confirmation).',
  newPassword: 'The new password; must satisfy the organization password policy.',
  token: 'Opaque token issued by the API.',
  code: 'Short code (TOTP or recovery code, or a business code).',
  limit: 'Page size applied.',
  nextCursor: 'Cursor for the next page, or `null` on the last page.',
  total: 'Total number of matching rows.',
  url: 'Absolute URL.',
  slug: 'URL slug (lowercase letters, digits, hyphens).',
  timezone: 'IANA time zone, e.g. `Europe/London`.',
  locale: 'BCP-47 locale, e.g. `en-GB`.',
  userId: 'Identifier (UUID) of the user.',
  projectId: 'Identifier (UUID) of the project.',
  taskId: 'Identifier (UUID) of the task.',
  roleId: 'Identifier (UUID) of the role.',
  teamId: 'Identifier (UUID) of the team.',
  startDate: 'Start date (`YYYY-MM-DD`).',
  endDate: 'End date (`YYYY-MM-DD`).',
  dueDate: 'Due date (`YYYY-MM-DD`).',
  from: 'Range start (inclusive).',
  to: 'Range end (inclusive).',
  permissions: 'Permission keys (see `listPermissions`).',
  metadata: 'Free-form metadata for the integration; documented per key where used.',
  details: 'Per-field problems.',
  message: 'Human-readable message.',
  requestId: 'Correlation id of the request.',
};

/** Fallback description for a schema property that has no explicit one. */
export function describeProperty(name: string): string {
  if (PROPS[name]) return PROPS[name]!;
  const idm = /^(.+)Id$/.exec(name);
  if (idm) return `Identifier (UUID) of the ${humanize(idm[1]!)}.`;
  const idsm = /^(.+)Ids$/.exec(name);
  if (idsm) return `Identifiers (UUIDs) of the ${humanize(idsm[1]!)}s.`;
  if (/At$/.test(name)) return `When ${humanize(name.replace(/At$/, ''))} happened (ISO-8601 UTC).`;
  if (/Date$/.test(name)) return `The ${humanize(name)} (\`YYYY-MM-DD\`).`;
  if (/^is[A-Z]/.test(name) || /^has[A-Z]/.test(name)) return `Whether ${humanize(name.replace(/^(is|has)/, ''))} applies.`;
  if (/Count$/.test(name)) return `Number of ${humanize(name.replace(/Count$/, ''))}.`;
  return `The ${humanize(name)}.`;
}
