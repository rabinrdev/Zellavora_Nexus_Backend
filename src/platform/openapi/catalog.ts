/** Tag catalog: human names, descriptions, grouping and the module → tag mapping used by the spec builder. */

export type TagGroup = 'Identity & Security' | 'Organization' | 'Operations' | 'Platform Control';

export interface TagDef {
  name: string;
  group: TagGroup;
  /** Release train the module shipped in. */
  release: 'MVP' | 'V1' | 'V2';
  /** What the module is for + the first thing a frontend developer should call. */
  description: string;
  /** Registry `module` values that belong to this tag. */
  modules: string[];
  /** Internal tags are excluded from the `frontend` audience spec. */
  internal?: boolean;
}

/** Order here is the order shown in Swagger UI / Redoc (Authentication first, not alphabetical). */
export const TAGS: TagDef[] = [
  { name: 'Authentication', group: 'Identity & Security', release: 'MVP', modules: ['auth'],
    description: 'Sign-up, sign-in, token refresh, MFA, password reset and session management for staff users. **Start here:** `loginWithPassword`, then call `getCurrentUser`.' },
  { name: 'Users & Access (IAM)', group: 'Identity & Security', release: 'MVP', modules: ['iam'],
    description: 'Members, roles, groups, permissions, access requests and access reviews. **First call:** `getMyPermissions` to know which actions to show.' },
  { name: 'Security & Privacy', group: 'Identity & Security', release: 'MVP', modules: ['security'],
    description: 'Security policy, API keys, privacy (data-subject) requests and secret references. **First call:** `getSecurityPolicy`.' },
  { name: 'Audit Logs', group: 'Identity & Security', release: 'MVP', modules: ['audit'],
    description: 'Append-only audit and security event history and retention. **First call:** `listAuditEvents`.' },
  { name: 'Organizations', group: 'Organization', release: 'MVP', modules: ['organizations'],
    description: 'The active organization, departments, locations, invitations, ownership transfer and deletion. **First call:** `getCurrentOrganization`.' },
  { name: 'Dashboard', group: 'Organization', release: 'MVP', modules: ['dashboard'],
    description: 'Role-aware dashboard composition, widgets, saved views and catalog reports. **First call:** `getDashboard`.' },
  { name: 'Settings', group: 'Organization', release: 'MVP', modules: ['settings'],
    description: 'Organization/application settings, the caller\'s profile and preferences, lookups and feature flags. **First call:** `getPublicConfig` (no login needed), then `getMyProfile`.' },
  { name: 'Data Lifecycle', group: 'Organization', release: 'MVP', modules: ['exports', 'data'],
    description: 'Exports, CSV imports, retention policies and permanent purge. Long-running work returns `202` and an id to poll. **First call:** `listExports`.' },
  { name: 'Documents & Files', group: 'Operations', release: 'V1', modules: ['files', 'documents'],
    description: 'File upload/download with signed links, and the document library (versions, metadata, ACLs). Behind flag `module.documents` for the library. **First call:** `getFileUsage`.' },
  { name: 'Workflows', group: 'Operations', release: 'V1', modules: ['workflow'],
    description: 'Versioned workflow definitions, rule testing and instance transitions. Behind flag `module.workflow`. **First call:** `listWorkflows`.' },
  { name: 'Notifications', group: 'Operations', release: 'V1', modules: ['notifications'],
    description: 'In-app notifications, preferences, templates and delivery log. Behind flag `module.notifications`. **First call:** `getMyUnreadNotificationCount`.' },
  { name: 'Teams', group: 'Operations', release: 'V1', modules: ['teams'],
    description: 'Teams, members, leaders and capacity. Behind flag `module.teams`. **First call:** `listTeams`.' },
  { name: 'Projects & Tasks', group: 'Operations', release: 'V1', modules: ['projects'],
    description: 'Projects, milestones, tasks (Kanban), comments, dependencies, templates and progress. Behind flag `module.projects`. **First call:** `listProjects`.' },
  { name: 'Timesheets', group: 'Operations', release: 'V1', modules: ['timesheets'],
    description: 'Weekly timesheets, entries, submission/approval and utilization reports. Behind flag `module.timesheets`. **First call:** `getMyTimesheet`.' },
  { name: 'Approvals', group: 'Operations', release: 'V1', modules: ['approvals'],
    description: 'Approval templates, requests, decisions and delegations. Behind flag `module.approvals`. **First call:** `listApprovalInbox`.' },
  { name: 'Invoices & Payments', group: 'Operations', release: 'V1', modules: ['invoices'],
    description: 'Billing customers, tax, invoices (gap-free numbering), payments, credit notes and receivables. Behind flag `module.invoices`. **First call:** `listInvoices`.' },
  { name: 'Clients & CRM', group: 'Operations', release: 'V1', modules: ['crm'],
    description: 'Leads, contacts, enquiries, follow-ups, client history and portal invitations. Behind flag `module.crm`. **First call:** `listLeads`.' },
  { name: 'Client Portal', group: 'Operations', release: 'V1', modules: ['portal'],
    description: 'Self-service API for invited client contacts (separate `portalAuth` realm). Behind flag `module.crm`. **First call:** `loginToPortal`.' },
  { name: 'Content (CMS)', group: 'Operations', release: 'V2', modules: ['cms'],
    description: 'Pages, posts, categories, media, versions and publishing. Behind flag `module.cms`. **First call:** `listPages`.' },
  { name: 'Page Builder', group: 'Operations', release: 'V2', modules: ['pagebuilder'],
    description: 'Block-based page editing and layout presets. Behind flag `module.pagebuilder`. **First call:** `listPageBlocks`.' },
  { name: 'Themes', group: 'Operations', release: 'V2', modules: ['themes'],
    description: 'Theme tokens, activation and brand assets. Behind flag `module.themes`. **First call:** `listThemes`.' },
  { name: 'Public Site Delivery', group: 'Operations', release: 'V2', modules: ['public'],
    description: 'Unauthenticated read-only delivery of published pages, posts and the active theme for an organization slug. **First call:** `listPublicPages`.' },
  { name: 'Subscription & Billing', group: 'Operations', release: 'V2', modules: ['billing'],
    description: 'Plans, the current subscription, usage and entitlements. Behind flag `module.billing`. **First call:** `getCurrentSubscription`.' },
  { name: 'Integrations & Webhooks', group: 'Operations', release: 'V2', modules: ['integrations'],
    description: 'Outbound webhook endpoints, delivery history/replay and integration configuration. Behind flag `module.integrations`. **First call:** `listWebhookEventCatalog`.' },
  { name: 'Reports', group: 'Operations', release: 'V2', modules: ['advanced_reports'],
    description: 'Ad-hoc report builder, saved reports/filters, exports and schedules. Behind flag `module.reports`. **First call:** `listReportDatasets`.' },
  { name: 'Help & Support', group: 'Operations', release: 'V2', modules: ['support'],
    description: 'Help articles, onboarding checklist and article feedback. Behind flag `module.support`. **First call:** `getOnboardingChecklist`.' },
  { name: 'Search', group: 'Operations', release: 'V1', modules: ['search'],
    description: 'Global, permission-aware search across modules. **First call:** `searchGlobal`.' },
  { name: 'Platform Operations (internal)', group: 'Platform Control', release: 'V2', modules: ['platform', 'platform_ops'], internal: true,
    description: 'Platform-admin only: releases, incidents, tenants, quotas, alerts, support sessions. Excluded from the `frontend` audience spec.' },
];

/** Routes under these prefixes are internal regardless of their module. */
export const INTERNAL_PATH_PREFIXES = ['/platform/'];
/** Routes that exist for third-party callers and are not part of the product UI contract. */
export const INTERNAL_PATHS = new Set(['/billing/webhooks/:provider']);

const byModule = new Map<string, TagDef>();
for (const t of TAGS) for (const m of t.modules) byModule.set(m, t);

export function tagFor(module: string, path: string): TagDef {
  if (INTERNAL_PATH_PREFIXES.some((p) => path.startsWith(p))) return TAGS.find((t) => t.name.startsWith('Platform Operations'))!;
  const t = byModule.get(module);
  if (!t) throw new Error(`No OpenAPI tag mapped for module "${module}" (add it to src/platform/openapi/catalog.ts)`);
  return t;
}

export const TAG_GROUPS: TagGroup[] = ['Identity & Security', 'Organization', 'Operations', 'Platform Control'];
