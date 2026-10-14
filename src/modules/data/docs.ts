import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const exportJob = rowOf('export_jobs', {
  describe: {
    kind: 'Export kind, e.g. `users`, `audit`, `invoices`.', format: '`csv`, `xlsx` or `json`.',
    status: '`pending`, `processing`, `completed` or `failed`.', fileId: 'Generated file once completed.',
    expiresAt: 'The generated file and its download links expire at this time.', params: 'Parameters the export was requested with.',
  },
});
const importJob = rowOf('import_jobs', {
  describe: {
    resource: 'What is being imported, e.g. `departments`.', status: '`pending`, `completed`, `failed` or `dry_run`.',
    dryRun: '`true` when nothing was persisted.', totalRows: 'Rows in the CSV.', successRows: 'Rows applied.', errorRows: 'Rows with problems.',
    errors: 'Row-level problems: `[{ row, field?, issue }]` (first 500).',
  },
});
const importError = z.object({
  row: z.number().int().describe('CSV row number (header is row 1).'), field: z.string().optional().describe('Offending column.'),
  issue: z.string().describe('What is wrong.'),
});
const retentionPolicy = rowOf('data_retention_policies', {
  describe: {
    resource: 'Retention-managed resource (`audit_events`, `export_jobs`, `departments`, `locations`, `files`).',
    retentionDays: 'Days to keep the data.', action: '`archive` or `purge`.', legalHold: 'While `true`, nothing is removed.',
  },
});

documentRoutes({
  createExport: {
    successStatus: 202, asyncJob: true,
    response: z.object({
      id: uuid.describe('Export id; poll `getExportById`.'), kind: z.string().describe('Export kind.'),
      format: z.enum(['csv', 'xlsx', 'json']).describe('Output format.'), status: z.literal('pending').describe('Initial status.'),
    }),
    requestExamples: { usersCsv: { kind: 'users', format: 'csv' }, auditJson: { kind: 'audit', format: 'json', params: { from: '2026-03-01T00:00:00.000Z' } } },
    description: 'Queues an asynchronous export (kinds: `users`, `audit`, `organization_data`, plus module exports such as `invoices` and `timesheets`). The caller must hold the kind\'s permission. Poll `getExportById` until `status` is `completed`, then use `downloadLink`.',
  },
  listExports: {
    response: exportJob, responseName: 'ExportJob',
    list: { sortable: ['created_at'], filterable: ['status', 'kind'], defaultSort: '-created_at', searchable: false },
    description: 'Export jobs of the organization, newest first.',
  },
  getExportById: {
    response: exportJob.extend({
      downloadLink: z.object({ url: z.string().describe('Signed relative download URL.'), expiresAt: isoDate.describe('Link expiry (5 minutes).') }).nullable()
        .describe('Present only when the export is `completed` and not expired.'),
    }),
    responseName: 'ExportJobDetail', description: 'Status of one export, with a fresh short-lived download link once it has completed.',
  },
  exportOrganizationData: {
    successStatus: 202, asyncJob: true,
    response: z.object({ id: uuid.describe('Export id.'), kind: z.string().describe('`organization_data`.'), format: z.string().describe('`json`.'), status: z.string().describe('`pending`.') }),
    description: 'Queues a JSON export of all organization data (portability). Poll `getExportById`.',
  },
  downloadImportTemplate: { errors: [404], description: 'Returns an empty CSV with the header row for the given import resource (`departments`, `locations`).' },
  importRecords: {
    successStatus: [200, 202],
    response: z.object({
      id: uuid.describe('Import job id.'), status: z.enum(['completed', 'failed', 'dry_run', 'pending']).describe('`pending` = queued (more than 200 rows); poll `getImportById`.'),
      total: z.number().int().describe('Rows in the file.'), applied: z.number().int().describe('Rows applied (0 on failure or dry run).').optional(),
      errors: z.array(importError).describe('Row-level problems; any error aborts the whole batch.').optional(),
    }),
    description: 'Uploads a CSV (`multipart/form-data`: `file`, `resource`, optional `dryRun=true`). Validation is all-or-nothing. Up to 200 rows run synchronously (`200`); larger files (max 20 000 rows, 5 MB) are queued (`202`). The caller needs the permission of the target resource.',
  },
  getImportById: { response: importJob, responseName: 'ImportJob', description: 'Result of an import including row-level errors.' },
  replaceRetentionPolicy: {
    successStatus: 200,
    response: z.object({
      resource: z.string().describe('Resource the policy applies to.'), retentionDays: z.number().int().describe('Days to keep.'),
      action: z.enum(['archive', 'purge']).describe('Action once the window has passed.'), legalHold: z.boolean().describe('Hold flag.'),
    }),
    description: 'Creates or replaces the policy of one retention-managed resource. Unsupported resources return `422`.',
  },
  listRetentionPolicies: { response: retentionPolicy, responseName: 'RetentionPolicy', collection: true, description: 'Retention policies configured for the organization.' },
  runRetention: {
    successStatus: 200,
    response: z.object({
      dryRun: z.boolean().describe('Whether anything was removed.'),
      report: z.record(z.string(), z.number().int()).describe('Rows affected (or that would be affected) per resource.'),
    }),
    description: 'Applies the retention policies now. `dryRun` defaults to `true`; send `false` to delete. Resources under legal hold are skipped.',
  },
  purgeRecord: {
    successStatus: 200, errors: [404, 409],
    response: z.object({ resource: z.string().describe('Resource type.'), id: uuid.describe('Purged record.'), purged: z.literal(true).describe('Always `true`.') }),
    description: 'Permanently deletes one **soft-deleted** record after the retention window (default 30 days). Legal hold, a record that is not deleted yet, or an open window return `409`; unreferenced rows only.',
  },
  requestOrganizationDeletion: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Deletion request id.'), executeAfter: isoDate.describe('Earliest time the data is erased (14-day grace period).'), status: z.literal('pending').describe('Initial status.') }),
    description: 'Starts organization deletion with a 14-day grace period; the organization is suspended meanwhile. `confirmCode` must equal the organization code. Cancel with `cancelOrganizationDeletion`.',
  },
  cancelOrganizationDeletion: { successStatus: 204, description: 'Cancels a pending deletion request and reactivates the organization.' },
  getDatabaseSchemaVersion: {
    response: z.object({
      current: z.string().nullable().describe('Name of the latest applied migration.'),
      applied: z.array(z.object({ name: z.string().describe('Migration file.'), batch: z.number().int().describe('Batch number.'), migrationTime: isoDate.describe('When it ran.') })).describe('Applied migrations in order.'),
    }),
    description: 'Platform administrators only. Read-only view of applied database migrations.',
  },
});
