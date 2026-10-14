/**
 * Generates docs/TRACEABILITY.md: one row per Feature ID (F-001…F-260) -> module, artifacts, migration, tests, status.
 * IDs come from the product plan sections; edit RANGES when scope changes, then `npm run docs:trace`.
 */
import { writeFileSync } from 'node:fs';

interface Range {
  from: number;
  to: number;
  module: string;
  artifact: string;
  migration: string;
  tests: string;
  status: 'done' | 'backend-n/a' | 'unmapped';
  flag?: string;
  note?: string;
}

const T = {
  auth: 'tests/auth.e2e.test.ts, tests/iam-org-auth.e2e.test.ts',
  iam: 'tests/platform.e2e.test.ts, tests/iam-org-auth.e2e.test.ts, tests/security/route-registry.test.ts',
  org: 'tests/platform.e2e.test.ts, tests/iam-org-auth.e2e.test.ts',
  v1: 'tests/v1.e2e.test.ts',
  v2: 'tests/v2.e2e.test.ts, tests/v2b.e2e.test.ts',
};
const M = {
  core: '20261014000100, 20261014000200',
  extras: '20261014000300',
  org: '20261014000400',
  purge: '20261014000500',
  data: '20261014000600',
  proj: '20261014000700',
  ops: '20261014000800',
  cms: '20261014000900',
  billing: '20261014001000',
  audit: '20261014001100',
};

const RANGES: Range[] = [
  { from: 1, to: 8, module: 'M1 Authentication', artifact: '/auth/* (register, login, refresh, logout, verify, reset, invitations/accept, mfa/*, sessions, me); src/modules/auth', migration: M.core, tests: T.auth, status: 'done' },
  { from: 9, to: 16, module: 'M2 IAM', artifact: '/users, /roles, /permissions, /groups, /access-requests, /me/permissions, /iam/*; src/modules/iam', migration: M.core, tests: T.iam, status: 'done' },
  { from: 17, to: 24, module: 'M3 Organizations', artifact: '/organization*, /departments, /locations, /invitations, /me/organizations, /auth/switch-organization', migration: `${M.core}, ${M.org}`, tests: T.org, status: 'done' },
  { from: 25, to: 32, module: 'M4 Dashboard & reporting', artifact: '/dashboard, /dashboard/widgets/:key, /dashboard/views, /reports*; widget registry', migration: M.core, tests: 'tests/v1.e2e.test.ts (module flags), tests/platform.e2e.test.ts', status: 'done' },
  { from: 33, to: 33, module: 'M5 Shared components (backend residue)', artifact: 'paginate() cursor/offset helper, whitelist sort/filter', migration: '-', tests: 'tests/platform.e2e.test.ts (pagination), tests/iam-org-auth.e2e.test.ts', status: 'done' },
  { from: 34, to: 35, module: 'M5 Shared components', artifact: '-', migration: '-', tests: '-', status: 'backend-n/a', note: 'frontend-only' },
  { from: 36, to: 36, module: 'M5 Shared components (backend residue)', artifact: 'stable error codes + standard error body (src/platform/errors.ts)', migration: '-', tests: 'tests/platform.unit.test.ts', status: 'done' },
  { from: 37, to: 37, module: 'M5 Shared components (backend residue)', artifact: '/files* ; src/platform/files.ts', migration: M.core, tests: 'tests/platform.e2e.test.ts (files)', status: 'done' },
  { from: 38, to: 38, module: 'M5 Shared components', artifact: '-', migration: '-', tests: '-', status: 'backend-n/a', note: 'frontend-only' },
  { from: 39, to: 39, module: 'M5 Shared components (backend residue)', artifact: 'locale-aware message catalog in error/notification rendering', migration: '-', tests: 'tests/v1.e2e.test.ts (templates)', status: 'done' },
  { from: 40, to: 40, module: 'M5 Shared components', artifact: '-', migration: '-', tests: '-', status: 'backend-n/a', note: 'frontend-only' },
  { from: 41, to: 48, module: 'M6 Settings', artifact: '/settings/*, /me/profile, /me/preferences, /lookups, /feature-flags, /config/public, maintenance mode', migration: `${M.core}, ${M.extras}`, tests: 'tests/platform.e2e.test.ts', status: 'done' },
  { from: 49, to: 56, module: 'M7 Audit', artifact: '/audit-events*, /security-events, /audit/retention-policy; recordAudit() in-transaction', migration: M.core, tests: 'tests/platform.e2e.test.ts', status: 'done' },
  { from: 57, to: 62, module: 'M8 Teams', artifact: '/teams*, members, leaders, permissions, department, history, capacity', migration: M.proj, tests: T.v1, status: 'done', flag: 'module.teams' },
  { from: 63, to: 69, module: 'M9 Projects & tasks', artifact: '/projects*, /tasks*, board, milestones, progress, reports', migration: M.proj, tests: T.v1, status: 'done', flag: 'module.projects' },
  { from: 70, to: 76, module: 'M10 Timesheets', artifact: '/timesheets*, entries, submit/recall/approve, corrections, reports, export', migration: M.ops, tests: T.v1, status: 'done', flag: 'module.timesheets' },
  { from: 77, to: 83, module: 'M11 Approvals', artifact: '/approvals*, /approval-templates, delegations, overdue escalation job', migration: M.ops, tests: T.v1, status: 'done', flag: 'module.approvals' },
  { from: 84, to: 90, module: 'M12 Invoices & payments', artifact: '/invoices*, /payments*, /credit-notes, /receivables/summary, PDF, numbering, tax', migration: M.ops, tests: T.v1, status: 'done', flag: 'module.invoices' },
  { from: 91, to: 97, module: 'M13 Notifications', artifact: '/notifications*, /notification-preferences, /notification-templates, delivery log', migration: M.ops, tests: T.v1, status: 'done', flag: 'module.notifications' },
  { from: 98, to: 103, module: 'M14 CRM & portal', artifact: '/leads, /contacts, /enquiries, /follow-ups, /clients/*, /portal/*', migration: M.cms, tests: T.v2, status: 'done', flag: 'module.crm' },
  { from: 104, to: 109, module: 'M15 Documents', artifact: '/documents*, /document-categories, ACL, versions, download-link', migration: M.cms, tests: T.v2, status: 'done', flag: 'module.documents' },
  { from: 110, to: 115, module: 'M16 CMS & blog', artifact: '/pages, /posts, /content-categories, /media, /public/:orgSlug/*', migration: M.cms, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.cms' },
  { from: 116, to: 122, module: 'M17 Page builder', artifact: '/pages/:id/blocks*, /layout-presets', migration: M.cms, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.pagebuilder' },
  { from: 123, to: 125, module: 'M18 Theme builder', artifact: '/themes*, /brand-assets, /public/:orgSlug/theme', migration: M.cms, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.themes' },
  { from: 126, to: 131, module: 'M19 Subscription & billing', artifact: '/plans, /subscriptions*, /usage*, /billing/webhooks/:provider', migration: M.billing, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.billing' },
  { from: 132, to: 136, module: 'M20 Integration hub', artifact: '/webhook-endpoints*, /webhook-events*, /webhook-deliveries*, /integrations, /api-keys', migration: `${M.billing}, ${M.extras}`, tests: 'tests/v2b.e2e.test.ts, tests/platform.e2e.test.ts', status: 'done', flag: 'module.integrations' },
  { from: 137, to: 140, module: 'M21 Advanced reporting', artifact: '/report-datasets, /reports/run, /saved-reports, /report-schedules, /reports/export', migration: M.billing, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.reports' },
  { from: 141, to: 145, module: 'M22 Platform operations', artifact: '/platform/tenants*, /organization/support-access, /platform/support/impersonate, /platform/health', migration: M.billing, tests: 'tests/v2b.e2e.test.ts, tests/gaps.e2e.test.ts', status: 'done', flag: 'module.platform_ops' },
  { from: 146, to: 151, module: 'M23 Data lifecycle', artifact: '/imports*, /exports*, /retention/*, /organization/deletion-request, soft delete/restore/purge, /platform/schema-version', migration: `${M.extras}, ${M.purge}, ${M.data}`, tests: 'tests/platform.e2e.test.ts, tests/gaps.e2e.test.ts', status: 'done' },
  { from: 152, to: 158, module: 'M24 Security & privacy', artifact: '/security/policy, /api-keys, /privacy-requests, secret references, key rotation, rate limiting, redaction', migration: `${M.extras}, ${M.purge}`, tests: 'tests/security/route-registry.test.ts, tests/platform.unit.test.ts, tests/platform.e2e.test.ts', status: 'done' },
  { from: 159, to: 165, module: 'M25 Reliability & operations', artifact: '/health/*, /metrics, jobs + DLQ, backup/restore scripts, incidents/deployments, env validation', migration: M.extras, tests: 'tests/v2b.e2e.test.ts, tests/platform.unit.test.ts', status: 'done' },
  { from: 166, to: 171, module: 'M26 Workflow engine', artifact: '/workflows*, JSON-logic evaluator, immutable versions', migration: `${M.proj}, ${M.ops}`, tests: 'tests/v1.e2e.test.ts, tests/iam-org-auth.e2e.test.ts', status: 'done', flag: 'module.workflow' },
  { from: 172, to: 178, module: 'M27 Quality & release', artifact: 'Vitest suites, route-registry isolation test, CI workflow, /platform/releases, readiness-check', migration: M.extras, tests: 'all tests; .github/workflows/ci.yml', status: 'done' },
  { from: 179, to: 184, module: 'M28 Help & adoption', artifact: '/help/articles*, /onboarding/checklist, feedback', migration: M.billing, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.support' },
  { from: 185, to: 187, module: 'M1 Authentication', artifact: 'recovery codes regenerate, session idle/absolute expiry, invitation expiry/revocation', migration: M.core, tests: T.auth, status: 'done' },
  { from: 188, to: 191, module: 'M2 IAM', artifact: 'permission inheritance, least-privilege defaults, access reviews, permission-change approvals', migration: `${M.extras}, ${M.org}`, tests: T.iam, status: 'done' },
  { from: 192, to: 194, module: 'M3 Organizations', artifact: 'suspend/reactivate, transfer ownership, data export', migration: M.org, tests: T.org, status: 'done' },
  { from: 195, to: 198, module: 'M5 Shared components', artifact: '-', migration: '-', tests: '-', status: 'backend-n/a', note: 'frontend-only' },
  { from: 199, to: 201, module: 'M4 Dashboard', artifact: 'saved views, widget permission+module gating, module_not_enabled state', migration: M.core, tests: 'tests/v1.e2e.test.ts', status: 'done' },
  { from: 202, to: 205, module: 'M9 Projects & tasks', artifact: 'dependencies (cycle-safe), recurring rules job, task activity, project templates', migration: M.proj, tests: T.v1, status: 'done', flag: 'module.projects' },
  { from: 206, to: 208, module: 'M10 Timesheets', artifact: 'overlap/duplicate rules, work-week + daily cap, correction audit', migration: M.ops, tests: T.v1, status: 'done', flag: 'module.timesheets' },
  { from: 209, to: 212, module: 'M11 Approvals', artifact: 'quorum, delegation, escalation, self-approval prevention', migration: M.ops, tests: T.v1, status: 'done', flag: 'module.approvals' },
  { from: 213, to: 216, module: 'M12 Invoices', artifact: 'credit notes, payment allocation, gap-free numbering, tax rules', migration: M.ops, tests: T.v1, status: 'done', flag: 'module.invoices' },
  { from: 217, to: 220, module: 'M15 Documents / files', artifact: 'type+size validation, malware scan fail-closed, signed downloads, quotas', migration: `${M.core}, ${M.cms}`, tests: 'tests/platform.e2e.test.ts, tests/v2.e2e.test.ts, tests/gaps.e2e.test.ts', status: 'done', flag: 'module.documents' },
  { from: 221, to: 225, module: 'M16-M18 CMS family', artifact: 'versions + rollback, preview links, publish permission, SEO preview, scheduled publish', migration: M.cms, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.cms' },
  { from: 226, to: 230, module: 'M19 Billing', artifact: 'lifecycle, dunning, grace/restrict/suspend, entitlements (402 PLAN_LIMIT_EXCEEDED)', migration: M.billing, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.billing' },
  { from: 231, to: 234, module: 'M20 Integration hub', artifact: 'signed webhooks, key rotation overlap, retries/auto-disable, replay', migration: M.billing, tests: 'tests/v2b.e2e.test.ts, tests/platform.unit.test.ts', status: 'done', flag: 'module.integrations' },
  { from: 235, to: 241, module: 'M22 Platform operations', artifact: 'tenant health, support access grants, backups, alerts, idempotent provisioning + job records, first-admin link', migration: M.billing, tests: 'tests/v2b.e2e.test.ts, tests/gaps.e2e.test.ts', status: 'done', flag: 'module.platform_ops' },
  { from: 242, to: 243, module: 'M2 IAM', artifact: 'consistent 403 body; immediate revocation via permission_version + session checks', migration: M.core, tests: 'tests/security/route-registry.test.ts, tests/platform.e2e.test.ts', status: 'done' },
  { from: 244, to: 247, module: 'M29 API standards', artifact: '/api/v1 versioning + Deprecation/Sunset, cursor pagination, Idempotency-Key, error contract', migration: `${M.core}, ${M.audit}`, tests: 'tests/platform.e2e.test.ts, tests/platform.unit.test.ts', status: 'done' },
  { from: 248, to: 250, module: 'M30/M31 (spec truncated)', artifact: '-', migration: '-', tests: '-', status: 'unmapped', note: 'feature rows not present in the received specification' },
  { from: 251, to: 253, module: 'M5 Shared components', artifact: '-', migration: '-', tests: '-', status: 'backend-n/a', note: 'frontend-only' },
  { from: 254, to: 255, module: 'M6 Settings', artifact: '/me/preferences (date/time/number formats, locale, timezone)', migration: M.core, tests: 'tests/platform.e2e.test.ts', status: 'done' },
  { from: 256, to: 256, module: 'M22 Platform operations', artifact: '/platform/diagnostics/:requestId, /platform/tenants/:id/config-check', migration: '-', tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.platform_ops' },
  { from: 257, to: 257, module: 'M19 Billing', artifact: '/usage/events (idempotent metering)', migration: M.billing, tests: 'tests/v2b.e2e.test.ts', status: 'done', flag: 'module.billing' },
  { from: 258, to: 260, module: 'M30/M31 (spec truncated)', artifact: '-', migration: '-', tests: '-', status: 'unmapped', note: 'feature rows not present in the received specification' },
];

const id = (n: number) => `F-${String(n).padStart(3, '0')}`;
const covered = new Map<number, Range>();
for (const r of RANGES) for (let n = r.from; n <= r.to; n++) {
  if (covered.has(n)) throw new Error(`${id(n)} mapped twice`);
  covered.set(n, r);
}
const missing: string[] = [];
for (let n = 1; n <= 260; n++) if (!covered.has(n)) missing.push(id(n));
if (missing.length) throw new Error(`Unmapped feature IDs: ${missing.join(', ')}`);

let md = '# Traceability matrix\n\n_Generated by `npm run docs:trace`. One row per Feature ID._\n\n';
const count = (s: string) => [...covered.values()].filter((r) => r.status === s).length;
md += `**260 features** · done: ${count('done')} · backend-n/a (frontend-only): ${count('backend-n/a')} · unmapped (spec truncated): ${count('unmapped')}\n\n`;
md += 'Status `done` + a flag means the module is fully built but registered behind its feature flag (default OFF in production, ON in dev/test).\n\n';
md += '| Feature | Module | Backend artifact | Migration(s) | Tests | Status |\n|---|---|---|---|---|---|\n';
for (let n = 1; n <= 260; n++) {
  const r = covered.get(n)!;
  const status = r.status === 'done' ? (r.flag ? `done (flag \`${r.flag}\`)` : 'done') : r.status === 'backend-n/a' ? `backend-n/a — ${r.note}` : `unmapped — ${r.note}`;
  md += `| ${id(n)} | ${r.module} | ${r.artifact} | ${r.migration} | ${r.tests} | ${status} |\n`;
}
writeFileSync('docs/TRACEABILITY.md', md);
console.log(`traceability written: ${covered.size} features`);
