import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

documentRoutes({
  listReportDatasets: {
    response: z.object({
      key: z.string().describe('Dataset key to use as `dataset` in a report definition.'),
      fields: z.array(z.object({ name: z.string().describe('Field name.'), type: z.string().describe('`string`, `number`, `date`, `boolean`, ...'), groupable: z.boolean().describe('Can be used in `groupBy`.'), aggregatable: z.boolean().describe('Can be used with an aggregation.') })).describe('Fields the caller may use (field-level permissions applied).'),
      operators: z.array(z.string()).describe('Filter operators: eq, neq, gt, gte, lt, lte, in, contains, is_null.'),
      aggregations: z.array(z.string()).describe('Aggregations: count, sum, avg, min, max.'),
    }),
    responseName: 'ReportDataset', collection: true, description: 'Datasets the caller may report on, with their fields. Build report definitions from this.',
  },
  runAdHocReport: {
    successStatus: 200, errors: [402],
    response: z.object({ rows: z.array(z.record(z.string(), z.unknown())).describe('Result rows keyed by selected column / aggregation alias.'), count: z.number().int().describe('Rows returned.'), truncated: z.boolean().describe('`true` when `limit` cut the result.') }),
    requestExamples: { projectsByStatus: { dataset: 'projects', select: ['status'], aggregations: [{ fn: 'count', as: 'projects' }], groupBy: ['status'], limit: 100 } },
    description: 'Runs a validated report definition (whitelisted dataset, fields, operators; 8-second statement timeout). Needs the `advanced_reports` entitlement.',
  },
  exportAdHocReport: {
    successStatus: 202, asyncJob: true, response: z.object({ id: uuid.describe('Export id; poll `getExportById`.'), kind: z.string().describe('`adhoc_report`.'), format: z.string().describe('Format.'), status: z.string().describe('`pending`.') }),
    description: 'Queues an export of an ad-hoc report. `Idempotency-Key` is supported.',
  },
  listSavedReports: {
    response: rowOf('saved_reports'), responseName: 'SavedReport', list: { sortable: ['name', 'created_at'], filterable: [], defaultSort: 'name' },
    description: 'Saved reports owned by the caller or shared with the organization.',
  },
  listSavedFilters: {
    response: rowOf('saved_filters'), responseName: 'SavedFilter', list: { sortable: ['name'], filterable: [], defaultSort: 'name' },
    description: 'Filters saved by the caller.',
  },
  createReportSchedule: {
    successStatus: 201, response: z.object({ id: uuid.describe('Schedule id.'), nextRunAt: isoDate.describe('When the report runs next.') }),
    description: 'Schedules a saved report to be emailed to organization members. Recipients must be active members (`422`).',
  },
  listReportSchedules: { response: rowOf('report_schedules'), responseName: 'ReportSchedule', collection: true, description: 'Active schedules ordered by next run.' },
  deleteReportSchedule: { successStatus: 204, description: 'Cancels a schedule.' },
});
