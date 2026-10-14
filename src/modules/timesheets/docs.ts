import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const sheet = rowOf('timesheets', { describe: { periodStart: 'First day of the week.', periodEnd: 'Last day of the week.', status: '`draft`, `submitted`, `approved` or `rejected`.', revision: 'Increments with each correction.' } });
const entry = rowOf('time_entries');
const sheetDetail = sheet.extend({
  totalMinutes: z.number().int().describe('All logged minutes.'), billableMinutes: z.number().int().describe('Billable minutes.'),
  entries: z.array(entry).describe('Time entries of the week.'),
});
const status = z.object({ id: uuid.describe('Timesheet id.'), status: z.string().describe('New status.') });

documentRoutes({
  getMyTimesheet: { response: sheetDetail, responseName: 'TimesheetDetail', description: 'The caller\'s timesheet for the week of `weekStart` (default: current week); created empty on first access.' },
  listTeamTimesheets: {
    response: sheet, responseName: 'Timesheet', list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false },
    description: 'Timesheets of members of the teams the caller leads (everyone with `timesheets:manage_all`). Extra filter: `status`.',
  },
  getTimesheetById: { response: sheetDetail, responseName: 'TimesheetDetail', description: 'Owner or reviewers only; others get `404`.' },
  createTimesheetEntry: {
    successStatus: 201, errors: [409], response: z.object({ id: uuid.describe('Entry id.') }).loose(), responseName: 'TimeEntryCreated',
    description: 'Logs time. Only drafts can change; per-day totals above `timesheets.max_hours_per_day` return `422`.',
  },
  updateTimesheetEntry: { successStatus: 200, response: entry, responseName: 'TimeEntry', errors: [409], description: 'Edits an entry of a draft timesheet.' },
  deleteTimesheetEntry: { successStatus: 204, errors: [409], description: 'Removes an entry of a draft timesheet.' },
  submitTimesheet: {
    successStatus: 200, errors: [409],
    response: z.object({ id: uuid.describe('Timesheet id.'), status: z.literal('submitted').describe('New status.'), approvalRequestId: uuid.nullable().describe('Linked approval request when a template is configured.') }),
    description: 'Submits for review. `Idempotency-Key` is supported.',
  },
  recallTimesheet: { successStatus: 200, response: status, errors: [409], description: 'Pulls a submitted timesheet back to `draft`.' },
  approveTimesheet: { successStatus: 200, response: status, errors: [409], description: 'Reviewer approves. Reviewers cannot approve their own timesheet.' },
  rejectTimesheet: { successStatus: 200, response: status, errors: [409], description: 'Reviewer rejects with an optional `note`.' },
  createTimesheetCorrection: {
    successStatus: 201, response: z.object({ id: uuid.describe('Timesheet id.'), status: z.literal('draft').describe('Reopened as draft.'), revision: z.number().int().describe('New revision number.') }),
    description: 'Reopens an approved timesheet as a new revision; the reason is kept in the correction trail.',
  },
  listTimesheetCorrections: { response: rowOf('timesheet_corrections'), responseName: 'TimesheetCorrection', collection: true, description: 'Correction audit trail, oldest first.' },
  getTimesheetUtilizationReport: {
    response: z.object({
      userId: uuid.describe('Person.'), name: z.string().describe('Name.'), totalMinutes: z.number().int().describe('Approved minutes.'),
      billableMinutes: z.number().int().describe('Billable minutes.'), nonBillableMinutes: z.number().int().describe('Non-billable minutes.'),
      capacityMinutes: z.number().int().describe('Working minutes in the range.'), utilizationPct: z.number().describe('Total as % of capacity.'),
    }),
    responseName: 'UtilizationRow', collection: true, description: 'Approved time per person for `from`..`to`, compared with capacity.',
  },
  getTimesheetBillableReport: {
    response: z.object({
      projectId: uuid.nullable().describe('Project; `null` = no project.'), project: z.string().nullable().describe('Project name.'),
      billableMinutes: z.number().int().describe('Billable minutes.'), nonBillableMinutes: z.number().int().describe('Non-billable minutes.'),
    }),
    responseName: 'BillableRow', collection: true, description: 'Billable versus non-billable minutes per project.',
  },
  exportTimesheetEntries: {
    successStatus: 202, asyncJob: true,
    response: z.object({ id: uuid.describe('Export id; poll `getExportById`.'), kind: z.string().describe('`timesheets`.'), format: z.string().describe('Format.'), status: z.string().describe('`pending`.') }),
    description: 'Queues an export of time entries.',
  },
});
