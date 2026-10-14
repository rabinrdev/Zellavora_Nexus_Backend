import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';

const lookup = z.object({
  id: uuid.describe('Lookup value id.'), code: z.string().describe('Stable code to store in your records.'),
  label: z.string().describe('Label to show to users.'), sortOrder: z.number().int().describe('Display order.'),
  system: z.boolean().describe('`true` for platform-provided values (immutable).'),
});

const flagOverride = z.object({
  id: uuid.describe('Override id.'), flagKey: z.string().describe('Flag key.'),
  targetOrgId: uuid.nullable().describe('Organization the override applies to, or `null`.'),
  userId: uuid.nullable().describe('User the override applies to, or `null`.'), enabled: z.boolean().describe('Forced value.'),
});

const preferences = z.object({
  dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']).optional().describe('Date display format.'),
  timeFormat: z.enum(['24h', '12h']).optional().describe('Clock format.'),
  numberFormat: z.enum(['1,234.56', '1.234,56', '1 234,56']).optional().describe('Number display format.'),
  weekStart: z.number().int().min(0).max(6).optional().describe('First day of the week (0 = Sunday).'),
  theme: z.enum(['system', 'light', 'dark']).optional().describe('UI theme.'),
});

documentRoutes({
  getOrganizationSettings: {
    response: z.object({
      values: z.record(z.string(), z.unknown()).describe('Explicitly stored settings keyed by setting name (see `registry`); unset keys use platform defaults.'),
      registry: z.array(z.string()).describe('Every setting key that can be set.'),
    }),
    responseExample: { values: { 'invoices.default_payment_terms_days': 30, 'approvals.prevent_self_approval': true }, registry: ['iam.permission_change_approval', 'invoices.default_payment_terms_days'] },
    description: 'Typed organization settings. Allowed keys: `iam.permission_change_approval` (boolean), `iam.default_member_role` (`viewer`|`member`|`none`), `storage.quota_bytes` (integer), `timesheets.max_hours_per_day` / `timesheets.work_hours_per_day` (number 1-24), `timesheets.work_week` (array of weekday numbers 0-6), `approvals.prevent_self_approval` (boolean), `notifications.digest` (`off`|`daily`|`weekly`), `branding.show_logo` (boolean), `invoices.default_payment_terms_days` (0-365), `invoices.rounding` (`half_up`|`half_even`|`down`|`up`).',
  },
  updateOrganizationSettings: {
    response: z.object({ updated: z.array(z.string()).describe('Keys that were changed.') }),
    requestExamples: { paymentTerms: { 'invoices.default_payment_terms_days': 30 }, approvals: { 'approvals.prevent_self_approval': true } },
    description: 'Sets one or more settings in a single call. Unknown keys or invalid values reject the whole request with `422` listing every problem. Changes are audited with old and new values.',
  },
  getApplicationSettings: {
    response: z.record(z.string(), z.unknown()).describe('Application setting key → value (`maintenance_mode`, `maintenance_message`, `signup_enabled`).'),
    description: 'Platform administrators only. Keys: `maintenance_mode`, `maintenance_message`, `signup_enabled`.',
  },
  updateApplicationSettings: {
    response: z.object({ updated: z.array(z.string()).describe('Keys that were changed.') }),
    description: 'Platform administrators only. Setting `maintenance_mode` to `true` makes every non-health route answer `503 MAINTENANCE` (platform administrators excepted).',
  },
  getMyProfile: {
    response: z.object({
      id: uuid.describe('User id.'), email: z.string().email().describe('Sign-in email.'), name: z.string().describe('Display name.'),
      locale: z.string().describe('BCP-47 locale, e.g. `en-GB`.'), timezone: z.string().describe('IANA time zone.'),
      emailVerifiedAt: isoDate.nullable().describe('When the email was verified.'), createdAt: isoDate.describe('Account creation.'),
    }),
    responseName: 'MyProfile', description: 'The signed-in user\'s own profile. Works in any organization state, including suspended.',
  },
  updateMyProfile: {
    successStatus: 200,
    response: z.object({
      id: uuid.describe('User id.'), email: z.string().email().describe('Sign-in email.'), name: z.string().describe('Display name.'),
      locale: z.string().describe('Locale.'), timezone: z.string().describe('Time zone.'),
    }),
    responseName: 'MyProfileUpdate', description: 'Updates display name, locale and time zone. The email cannot be changed here.',
  },
  getMyPreferences: {
    response: preferences, responseName: 'MyPreferences',
    description: 'Display preferences. Only keys that were set are present (an empty object for new users).',
  },
  updateMyPreferences: {
    successStatus: 200, response: preferences, responseName: 'MyPreferences',
    description: 'Merges the given keys into the stored preferences and returns the merged result.',
  },
  listLookupValues: {
    response: lookup, responseName: 'LookupValue', collection: true,
    description: 'Active values of a lookup type: platform values plus the organization\'s own, ordered by `sortOrder` then label. Use these to fill dropdowns.',
  },
  createLookupValue: {
    successStatus: 201, errors: [409],
    response: z.object({ id: uuid.describe('New value id.'), code: z.string().describe('Code.'), label: z.string().describe('Label.'), sortOrder: z.number().int().describe('Order.') }),
    description: 'Adds an organization-specific value to a lookup type (the type is created for the organization if it does not exist). Duplicate codes return `409`.',
  },
  updateLookupValue: {
    successStatus: 200,
    response: z.object({
      id: uuid.describe('Value id.'), label: z.string().optional().describe('New label.'), sortOrder: z.number().int().optional().describe('New order.'),
      active: z.boolean().optional().describe('Whether the value is selectable.'),
    }),
    description: 'Updates an organization lookup value. Platform values are immutable and return `404`.',
  },
  evaluateFeatureFlags: {
    response: z.record(z.string(), z.boolean()).describe('Flag key → enabled for the caller (organization and user overrides applied).'),
    responseExample: { 'module.projects': true, 'module.cms': false },
    description: 'Evaluated feature flags for the caller. Use it to hide navigation for disabled modules.',
  },
  listFeatureFlags: {
    response: z.object({
      key: z.string().describe('Flag key, e.g. `module.projects`.'), description: z.string().describe('What the flag controls.'),
      defaultEnabled: z.boolean().describe('Default value.'), updatedAt: isoDate.describe('Last change.'),
      overrides: z.array(flagOverride).describe('Organization/user specific overrides.'),
    }),
    responseName: 'FeatureFlag', collection: true, description: 'Platform administrators only. All flags with their overrides.',
  },
  replaceFeatureFlag: {
    successStatus: 200, response: z.object({ key: z.string().describe('The flag key.') }),
    description: 'Platform administrators only. Sets the default and/or creates/replaces one override (scoped to an organization and/or user).',
  },
  getPublicConfig: {
    successStatus: 200,
    response: z.object({
      apiVersion: z.string().describe('API version served, e.g. `v1`.'), environment: z.string().describe('`development`, `test` or `production`.'),
      maintenance: z.boolean().describe('`true` while maintenance mode is on.'),
      features: z.record(z.string(), z.boolean()).describe('Platform default value of every feature flag.'),
    }),
    description: 'Non-secret configuration for the sign-in screen. No authentication; available during maintenance.',
  },
});
