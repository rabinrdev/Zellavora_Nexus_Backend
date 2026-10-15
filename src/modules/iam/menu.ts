/**
 * Navigation menu registry. The frontend renders exactly what `GET /me/menu` returns; visibility is decided here
 * from the caller's permissions, the module flags of the organization and platform-admin status.
 * Hiding a menu entry is never enforcement: every endpoint still checks its own permission.
 */
export interface MenuItemDef {
  key: string;
  title: string;
  /** Frontend route. Omit for a pure group that only holds children. */
  path?: string;
  icon?: string;
  /** Visible when the caller holds at least one of these permissions. Omitted = no permission requirement. */
  anyPermission?: string[];
  /** Module flag that must be on for the organization. */
  moduleFlag?: string;
  /** Visible to platform administrators only. */
  platformAdminOnly?: boolean;
  children?: MenuItemDef[];
}

export const MENU: MenuItemDef[] = [
  { key: 'dashboard', title: 'Dashboard', path: '/dashboard', icon: 'layout-dashboard', anyPermission: ['dashboard:read'] },
  {
    key: 'people', title: 'People & Access', icon: 'users',
    children: [
      { key: 'people.users', title: 'Users', path: '/users', anyPermission: ['users:read'] },
      { key: 'people.invitations', title: 'Invitations', path: '/invitations', anyPermission: ['invitations:read'] },
      { key: 'people.roles', title: 'Roles', path: '/roles', anyPermission: ['roles:read'] },
      { key: 'people.groups', title: 'Groups', path: '/groups', anyPermission: ['groups:read'] },
      { key: 'people.permissions', title: 'Permission matrix', path: '/iam/permission-matrix', anyPermission: ['iam:read'] },
      { key: 'people.access_requests', title: 'Access requests', path: '/access-requests', anyPermission: ['access_requests:read'] },
      { key: 'people.change_requests', title: 'Permission changes', path: '/iam/permission-change-requests', anyPermission: ['iam:approve'] },
    ],
  },
  {
    key: 'organization', title: 'Organization', icon: 'building',
    children: [
      { key: 'organization.profile', title: 'Profile', path: '/organization', anyPermission: ['organization:read'] },
      { key: 'organization.departments', title: 'Departments', path: '/departments', anyPermission: ['departments:read'] },
      { key: 'organization.locations', title: 'Locations', path: '/locations', anyPermission: ['locations:read'] },
      { key: 'organization.teams', title: 'Teams', path: '/teams', anyPermission: ['teams:read'], moduleFlag: 'module.teams' },
      { key: 'organization.settings', title: 'Settings', path: '/settings/organization', anyPermission: ['settings:read'] },
    ],
  },
  {
    key: 'work', title: 'Work', icon: 'briefcase',
    children: [
      { key: 'work.projects', title: 'Projects', path: '/projects', anyPermission: ['projects:read'], moduleFlag: 'module.projects' },
      { key: 'work.project_templates', title: 'Project templates', path: '/project-templates', anyPermission: ['project_templates:read'], moduleFlag: 'module.projects' },
      { key: 'work.workflows', title: 'Workflows', path: '/workflows', anyPermission: ['workflows:read'], moduleFlag: 'module.workflow' },
      {
        key: 'work.timesheets', title: 'Timesheets', icon: 'clock', moduleFlag: 'module.timesheets',
        children: [
          { key: 'work.timesheets.mine', title: 'My timesheets', path: '/timesheets/mine', anyPermission: ['timesheets:read'] },
          { key: 'work.timesheets.team', title: 'Team timesheets', path: '/timesheets/team', anyPermission: ['timesheets:review'] },
          { key: 'work.timesheets.utilization', title: 'Utilization', path: '/timesheets/reports/utilization', anyPermission: ['timesheets:read'] },
          { key: 'work.timesheets.billable', title: 'Billable report', path: '/timesheets/reports/billable', anyPermission: ['timesheets:review'] },
        ],
      },
      {
        key: 'work.approvals', title: 'Approvals', icon: 'check-circle', moduleFlag: 'module.approvals',
        children: [
          { key: 'work.approvals.inbox', title: 'Inbox', path: '/approvals/inbox', anyPermission: ['approvals:read'] },
          { key: 'work.approvals.history', title: 'History', path: '/approvals/history', anyPermission: ['approvals:read'] },
          { key: 'work.approvals.templates', title: 'Templates', path: '/approval-templates', anyPermission: ['approval_templates:read'] },
        ],
      },
    ],
  },
  {
    key: 'crm', title: 'CRM', icon: 'handshake', moduleFlag: 'module.crm',
    children: [
      { key: 'crm.leads', title: 'Leads', path: '/leads', anyPermission: ['leads:read'] },
      { key: 'crm.contacts', title: 'Contacts', path: '/contacts', anyPermission: ['contacts:read'] },
      { key: 'crm.enquiries', title: 'Enquiries', path: '/enquiries', anyPermission: ['enquiries:read'] },
      { key: 'crm.follow_ups', title: 'Follow-ups', path: '/follow-ups', anyPermission: ['follow_ups:read'] },
    ],
  },
  {
    key: 'finance', title: 'Finance', icon: 'receipt', moduleFlag: 'module.invoices',
    children: [
      { key: 'finance.invoices', title: 'Invoices', path: '/invoices', anyPermission: ['invoices:read'] },
      { key: 'finance.credit_notes', title: 'Credit notes', path: '/credit-notes', anyPermission: ['credit_notes:read'] },
      { key: 'finance.payments', title: 'Payments', path: '/payments', anyPermission: ['payments:read'] },
      { key: 'finance.customers', title: 'Customers', path: '/billing-customers', anyPermission: ['customers:read'] },
      { key: 'finance.receivables', title: 'Receivables', path: '/receivables/summary', anyPermission: ['invoices:read'] },
      { key: 'finance.tax', title: 'Tax configuration', path: '/tax-configurations', anyPermission: ['tax_configs:read'] },
      { key: 'finance.numbering', title: 'Numbering rules', path: '/numbering-rules', anyPermission: ['invoices:read'] },
    ],
  },
  {
    key: 'content', title: 'Content', icon: 'file-text',
    children: [
      { key: 'content.documents', title: 'Documents', path: '/documents', anyPermission: ['documents:read'], moduleFlag: 'module.documents' },
      { key: 'content.document_categories', title: 'Document categories', path: '/document-categories', anyPermission: ['document_categories:read'], moduleFlag: 'module.documents' },
      { key: 'content.files', title: 'Files', path: '/files', anyPermission: ['files:read'] },
      { key: 'content.pages', title: 'Pages', path: '/pages', anyPermission: ['pages:read'], moduleFlag: 'module.cms' },
      { key: 'content.posts', title: 'Posts', path: '/posts', anyPermission: ['posts:read'], moduleFlag: 'module.cms' },
      { key: 'content.categories', title: 'Content categories', path: '/content-categories', anyPermission: ['content_categories:read'], moduleFlag: 'module.cms' },
      { key: 'content.media', title: 'Media', path: '/media', anyPermission: ['media:read'], moduleFlag: 'module.cms' },
      { key: 'content.layouts', title: 'Layout presets', path: '/layout-presets', anyPermission: ['pages:read'], moduleFlag: 'module.pagebuilder' },
      { key: 'content.themes', title: 'Themes', path: '/themes', anyPermission: ['themes:read'], moduleFlag: 'module.themes' },
    ],
  },
  {
    key: 'reports', title: 'Reports', icon: 'bar-chart', moduleFlag: 'module.reports',
    children: [
      { key: 'reports.catalog', title: 'Reports', path: '/reports', anyPermission: ['reports:read'] },
      { key: 'reports.datasets', title: 'Datasets', path: '/report-datasets', anyPermission: ['reports:read'] },
      { key: 'reports.schedules', title: 'Schedules', path: '/report-schedules', anyPermission: ['reports:read'] },
      { key: 'reports.saved', title: 'Saved reports', path: '/saved-reports', anyPermission: ['saved_reports:read'] },
      { key: 'reports.filters', title: 'Saved filters', path: '/saved-filters', anyPermission: ['saved_reports:read'] },
    ],
  },
  { key: 'notifications', title: 'Notifications', path: '/notifications', icon: 'bell', anyPermission: ['notifications:read'], moduleFlag: 'module.notifications' },
  {
    key: 'integrations', title: 'Integrations', icon: 'plug', moduleFlag: 'module.integrations',
    children: [
      { key: 'integrations.apps', title: 'Integrations', path: '/integrations', anyPermission: ['integrations:read'] },
      { key: 'integrations.webhooks', title: 'Webhook endpoints', path: '/webhook-endpoints', anyPermission: ['webhooks:read'] },
      { key: 'integrations.deliveries', title: 'Webhook deliveries', path: '/webhook-deliveries', anyPermission: ['webhooks:read'] },
    ],
  },
  {
    key: 'billing', title: 'Subscription', icon: 'credit-card', moduleFlag: 'module.billing',
    children: [
      { key: 'billing.current', title: 'Current plan', path: '/subscriptions/current', anyPermission: ['billing:read'] },
      { key: 'billing.usage', title: 'Usage', path: '/usage', anyPermission: ['billing:read'] },
    ],
  },
  {
    key: 'security', title: 'Security & Audit', icon: 'shield',
    children: [
      { key: 'security.policy', title: 'Security policy', path: '/security/policy', anyPermission: ['security:read'] },
      { key: 'security.api_keys', title: 'API keys', path: '/api-keys', anyPermission: ['api_keys:read'] },
      { key: 'security.privacy', title: 'Privacy requests', path: '/privacy-requests', anyPermission: ['privacy:read'] },
      { key: 'security.audit', title: 'Audit log', path: '/audit-events', anyPermission: ['audit:read'] },
      { key: 'security.events', title: 'Security events', path: '/security-events', anyPermission: ['audit:read'] },
      { key: 'security.retention', title: 'Retention', path: '/retention/policies', anyPermission: ['retention:manage'] },
      { key: 'security.exports', title: 'Exports', path: '/exports', anyPermission: ['exports:read'] },
      { key: 'security.support_access', title: 'Support access', path: '/organization/support-access', anyPermission: ['support_access:manage'], moduleFlag: 'module.platform_ops' },
    ],
  },
  {
    key: 'help', title: 'Help', icon: 'life-buoy', moduleFlag: 'module.support',
    children: [
      { key: 'help.articles', title: 'Articles', path: '/help/articles', anyPermission: ['help:read'] },
      { key: 'help.onboarding', title: 'Onboarding', path: '/onboarding/checklist', anyPermission: ['help:read'] },
      { key: 'help.feedback', title: 'Feedback summary', path: '/help/feedback-summary', anyPermission: ['help:manage'] },
    ],
  },
  {
    key: 'platform', title: 'Platform', icon: 'server', platformAdminOnly: true,
    children: [
      { key: 'platform.health', title: 'Health', path: '/platform/health' },
      { key: 'platform.jobs', title: 'Jobs', path: '/platform/jobs' },
      { key: 'platform.incidents', title: 'Incidents', path: '/platform/incidents' },
      { key: 'platform.releases', title: 'Releases', path: '/platform/releases' },
      { key: 'platform.deployments', title: 'Deployments', path: '/platform/deployments' },
      { key: 'platform.backups', title: 'Backups', path: '/platform/backups' },
      { key: 'platform.feature_flags', title: 'Feature flags', path: '/feature-flags' },
      { key: 'platform.app_settings', title: 'Application settings', path: '/settings/application' },
      { key: 'platform.alerts', title: 'Alerts', path: '/platform/alerts', moduleFlag: 'module.platform_ops' },
      { key: 'platform.provisioning', title: 'Provisioning jobs', path: '/platform/provisioning-jobs', moduleFlag: 'module.platform_ops' },
    ],
  },
];

export interface MenuNode {
  key: string;
  title: string;
  path: string | null;
  icon: string | null;
  children: MenuNode[];
}

export interface MenuViewer {
  permissions: ReadonlySet<string>;
  isPlatformAdmin: boolean;
  /** Module flag key → enabled for the caller's organization. */
  flags: Readonly<Record<string, boolean>>;
}

/** Every module flag referenced by the registry, so the caller evaluates only those. */
export function menuFlagKeys(defs: MenuItemDef[] = MENU): string[] {
  const keys = new Set<string>();
  const walk = (items: MenuItemDef[]) => {
    for (const i of items) {
      if (i.moduleFlag) keys.add(i.moduleFlag);
      if (i.children) walk(i.children);
    }
  };
  walk(defs);
  return [...keys];
}

/**
 * Filters the registry for one caller. A group appears only when at least one child survives; a leaf appears when
 * its permission (any-of), module flag and platform-admin requirement are all satisfied.
 */
export function buildMenu(viewer: MenuViewer, defs: MenuItemDef[] = MENU): MenuNode[] {
  const out: MenuNode[] = [];
  for (const d of defs) {
    if (d.platformAdminOnly && !viewer.isPlatformAdmin) continue;
    if (d.moduleFlag && !viewer.flags[d.moduleFlag]) continue;
    if (d.anyPermission && !d.anyPermission.some((p) => viewer.permissions.has(p))) continue;
    const children = d.children ? buildMenu(viewer, d.children) : [];
    if (d.children && children.length === 0 && !d.path) continue;
    out.push({ key: d.key, title: d.title, path: d.path ?? null, icon: d.icon ?? null, children });
  }
  return out;
}
