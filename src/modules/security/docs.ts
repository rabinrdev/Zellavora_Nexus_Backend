import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const policy = z.object({
  password: z.object({ minLength: z.number().int().optional().describe('Minimum length (8-128).'), requireClasses: z.number().int().optional().describe('Required character classes (1-4).'), historyDepth: z.number().int().optional().describe('Previous passwords that cannot be reused (0-24).') })
    .optional().describe('Password rules.'),
  session: z.object({ idleMinutes: z.number().int().optional().describe('Idle timeout in minutes.'), absoluteMinutes: z.number().int().optional().describe('Absolute session lifetime in minutes.') })
    .optional().describe('Session lifetimes.'),
  lockout: z.object({ threshold: z.number().int().optional().describe('Failed attempts before lockout.'), baseMinutes: z.number().int().optional().describe('First lockout duration.'), maxMinutes: z.number().int().optional().describe('Longest lockout duration.') })
    .optional().describe('Brute-force lockout.'),
  mfa: z.object({ requiredForAll: z.boolean().optional().describe('Require MFA for every member.'), requiredForRoles: z.array(z.string()).optional().describe('Role keys that must use MFA.') })
    .optional().describe('Multi-factor authentication rules.'),
  allowedIpRanges: z.array(z.string()).optional().describe('CIDR ranges allowed to sign in (empty = any).'),
});

const apiKey = rowOf('api_keys', {
  only: ['id', 'name', 'prefix', 'scopes', 'expires_at', 'last_used_at', 'revoked_at', 'created_at'],
  describe: { prefix: 'Visible key prefix for identification.', scopes: 'Permission keys the key is limited to.', expiresAt: 'Expiry; `null` = never.', lastUsedAt: 'Last successful use.', revokedAt: 'When the key was revoked.' },
});

documentRoutes({
  getSecurityPolicy: {
    response: z.object({
      defaults: policy.describe('Platform defaults applied when the organization sets nothing.'),
      organization: policy.describe('Organization overrides (empty object when none).'),
    }),
    description: 'Returns the platform defaults and the organization overrides; the effective value of a rule is the override when present, else the default.',
  },
  replaceSecurityPolicy: {
    successStatus: 200, response: z.object({ organization: policy.describe('The stored organization policy.') }),
    description: 'Replaces the organization security policy. `session.idleMinutes` may not exceed `session.absoluteMinutes` (`422`). Changes are audited.',
  },
  createApiKey: {
    successStatus: 201, errors: [402],
    response: z.object({
      id: uuid.describe('Key id.'), name: z.string().describe('Key name.'), prefix: z.string().describe('Visible prefix.'),
      scopes: z.array(z.string()).describe('Granted permission scopes.'), key: z.string().describe('The secret, `nxk_<prefix>_<random>`. **Shown once** — store it now.'),
    }),
    responseExample: { id: '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f', name: 'CI exporter', prefix: 'ab12c', scopes: ['projects:read'], key: 'nxk_ab12c_EXAMPLE' },
    description: 'Creates a machine API key. Scopes must be permissions the creator holds. Use it as `Authorization: Bearer nxk_…`. Requires the `api_access` entitlement (`402` otherwise).',
  },
  listApiKeys: {
    response: apiKey, responseName: 'ApiKey',
    list: { sortable: ['created_at', 'name'], filterable: [], defaultSort: '-created_at', searchable: false },
    description: 'API keys of the organization. Secrets are never returned.',
  },
  revokeApiKey: {
    successStatus: 200, response: z.object({ id: uuid.describe('Key id.'), revoked: z.literal(true).describe('Always `true`.') }),
    description: 'Revokes a key immediately.',
  },
  rotateApiKey: {
    successStatus: 201,
    response: z.object({
      id: uuid.describe('New key id.'), prefix: z.string().describe('New visible prefix.'), key: z.string().describe('The new secret. **Shown once.**'),
      previousKeyExpiresAt: isoDate.describe('When the old key stops working (end of the overlap window).'),
    }),
    requestExamples: { oneHourOverlap: { overlapMinutes: 60 } },
    description: 'Issues a replacement key with the same scopes. The old key keeps working for `overlapMinutes` (default 60) so deployments can switch over.',
  },
  createPrivacyRequest: {
    successStatus: 201, response: z.object({ id: uuid.describe('Request id.'), status: z.literal('open').describe('Initial status.') }),
    description: 'Files a data-subject request (`access`, `export`, `erasure`, `rectification`). Users file for themselves; filing for others needs `privacy:manage`. The due date is 30 days.',
  },
  listPrivacyRequests: {
    response: rowOf('privacy_requests'), responseName: 'PrivacyRequest',
    list: { sortable: ['created_at', 'due_at'], filterable: ['status', 'kind'], defaultSort: '-created_at', searchable: false },
    description: 'Data-subject requests. Without `privacy:manage` only the caller\'s own are listed.',
  },
  processPrivacyRequest: {
    successStatus: 200,
    response: z.object({
      id: uuid.describe('Request id.'), status: z.literal('completed').describe('Final status.'),
      fileId: uuid.optional().describe('Generated data package (access/export requests).'),
      anonymized: z.boolean().optional().describe('Erasure: `true` when the identity was anonymized (last organization).'),
      removedFromOrganization: z.boolean().optional().describe('Erasure: removed from this organization only.'),
      note: z.string().optional().describe('Rectification note.'),
    }),
    description: 'Fulfils the request: access/export produce a JSON package file; erasure removes the member and anonymizes the account when this was their last organization. An owner cannot be erased before transferring ownership (`409`).',
  },
  createSecretReference: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Reference id.'), name: z.string().describe('Upper-case reference name.'), provider: z.string().describe('Secret provider, e.g. `env`.'), version: z.number().int().describe('Reference version.') }),
    errors: [409], description: 'Registers the **name** of a secret held in an external store. Values are never accepted or stored.',
  },
  listSecretReferences: { response: rowOf('secret_references'), responseName: 'SecretReference', collection: true, description: 'Registered secret references (names only).' },
  rotateEncryptionKey: {
    successStatus: 200,
    response: z.object({ reencrypted: z.number().int().describe('Secrets re-encrypted.'), keyVersion: z.number().int().describe('Current key version.') }),
    description: 'Platform administrators only. Re-encrypts stored secrets (MFA factors) with the current data-encryption key version.',
  },
});
