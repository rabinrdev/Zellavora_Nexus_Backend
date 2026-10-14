import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const widgetState = z.enum(['ok', 'module_not_enabled']).describe('`module_not_enabled` when the owning module is switched off for the organization.');
const widgetKeys = [
  '`members.summary` → `{ byStatus: { active: number, ... }, pendingInvitations: number }`',
  '`activity.recent` → array of `{ id, occurred_at, actor_id, action, resource_type, resource_id, outcome }`',
  '`activity.trend` → array of `{ bucket: ISO date, count: number }` (bucketed by `granularity`)',
  '`access.pending_requests` → `{ pending: number }`',
  '`storage.usage` → `{ usedBytes: number, quotaBytes: number }`',
].join('\n- ');
const view = rowOf('saved_dashboard_views', {
  describe: { name: 'Name of the saved view.', filters: 'Saved dashboard filters (date range, granularity, ...).', userId: 'Owner; views are private to their owner.' },
});

documentRoutes({
  getDashboard: {
    response: z.object({
      widgets: z.array(z.object({
        key: z.string().describe('Widget key, e.g. `members.summary`.'), title: z.string().describe('Display title.'), state: widgetState,
        data: z.unknown().describe('Widget payload; shape depends on the key (see the operation description). Absent when `state` is `module_not_enabled`.').optional(),
      })).describe('Widgets the caller may see (permission and module flag both allow).'),
    }),
    description: `Composes the dashboard from the widget registry: only widgets whose permission the caller holds are returned. \`from\`/\`to\` default to the last 30 days (max range 366 days); \`granularity\` buckets trend widgets.\n\n**Widget payloads**\n- ${widgetKeys}`,
  },
  getDashboardWidgetByKey: {
    response: z.object({
      key: z.string().describe('Widget key.'), state: widgetState,
      from: isoDate.optional().describe('Range start used.'), to: isoDate.optional().describe('Range end used.'),
      data: z.unknown().describe('Widget payload (see `getDashboard`).').optional(),
    }),
    description: `One widget for drill-down with its own date range. Unknown widgets or widgets the caller may not see return \`404\`.\n\n**Widget payloads**\n- ${widgetKeys}`,
  },
  listReports: {
    response: z.object({ key: z.string().describe('Report key to pass to `getReportByKey`.'), title: z.string().describe('Report title.') }),
    responseName: 'ReportSummary', collection: true,
    description: 'Catalog reports the caller may run (`members`, `audit_summary`). For ad-hoc reports see `runAdHocReport`.',
  },
  getReportByKey: {
    response: z.object({
      state: widgetState, rows: z.array(z.record(z.string(), z.unknown())).describe('Result rows; columns depend on the report (see description). Capped at 5000.'),
      truncated: z.boolean().optional().describe('`true` when more than 5000 rows matched.'),
    }),
    description: 'Runs a catalog report. `members` → `{ email, name, status, joined_at }`; `audit_summary` → `{ action, outcome, events }` (filter with `from`/`to`).',
  },
  exportReportByKey: {
    successStatus: 202, asyncJob: true,
    response: z.object({ id: uuid.describe('Export id; poll `getExportById`.'), kind: z.string().describe('`report.<key>`.'), format: z.string().describe('Output format.'), status: z.string().describe('`pending`.') }),
    description: 'Queues an export of a catalog report in `csv`, `xlsx` or `json`.',
  },
  listDashboardViews: {
    list: { sortable: ['created_at', 'name'], filterable: [], defaultSort: 'name', searchable: false },
    description: 'Saved dashboard views of the signed-in user (views are private).',
  },
});

void view;
