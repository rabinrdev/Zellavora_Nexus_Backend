import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const taskStatus = z.enum(['todo', 'in_progress', 'in_review', 'done', 'cancelled']).describe('Kanban column / lifecycle status.');
const task = rowOf('tasks', {
  describe: {
    projectId: 'Project the task belongs to.', title: 'Task title.', description: 'Free-text description.',
    status: '`todo`, `in_progress`, `in_review`, `done` or `cancelled`.', priority: '`low`, `medium`, `high` or `urgent`.',
    assigneeId: 'Assigned member.', dueDate: 'Due date.', estimateHours: 'Estimated effort in hours (decimal string).',
    parentTaskId: 'Parent task for sub-tasks.', milestoneId: 'Milestone the task counts towards.',
    position: 'Sort position inside its column (fractional ordering).', completedAt: 'When the task reached `done`.',
  },
});
const milestone = rowOf('milestones', { describe: { name: 'Milestone name.', dueDate: 'Target date.', status: '`open`, `reached` or `missed`.' } });
const recurring = rowOf('recurring_task_rules', {
  describe: { frequency: '`daily`, `weekly` or `monthly`.', intervalCount: 'Every N periods.', nextRunOn: 'Next date a task is generated.', endOn: 'Last date; `null` = forever.', active: '`false` after deactivation.' },
});
const projectMember = z.object({
  userId: uuid.describe('Member user id.'), name: z.string().describe('Display name.'), email: z.string().email().describe('Email.'),
  role: z.enum(['lead', 'contributor', 'viewer']).describe('Project role.'),
});

documentRoutes({
  listProjectMembers: {
    response: projectMember, responseName: 'ProjectMember', collection: true,
    description: 'Members of the project and their project role. Organization managers (`projects:manage_all`) see every project; others see projects they own or belong to.',
  },
  setProjectMemberRole: {
    successStatus: 200,
    response: z.object({ projectId: uuid.describe('Project.'), userId: uuid.describe('Member.'), role: z.enum(['lead', 'contributor', 'viewer']).describe('Role now assigned.') }),
    description: 'Adds a member or changes their project role. The caller needs project role `lead`; the target must be an active organization member.',
  },
  removeProjectMember: { successStatus: 204, errors: [409], description: 'Removes a project member. The project owner cannot be removed (`409`).' },
  listProjectMilestones: { response: milestone, responseName: 'Milestone', collection: true, description: 'Milestones ordered by due date.' },
  createProjectMilestone: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Milestone id.'), name: z.string().describe('Name.'), dueDate: z.string().nullable().optional().describe('Due date.') }),
    description: 'Creates a milestone. Requires project role `contributor`.',
  },
  updateMilestone: { successStatus: 200, response: milestone, responseName: 'Milestone', description: 'Updates name, due date or status (`open`, `reached`, `missed`). An empty body returns `422`.' },
  listProjectTasks: {
    response: task, responseName: 'Task',
    list: { sortable: ['created_at', 'due_date', 'priority', 'position', 'title'], filterable: [], defaultSort: 'position' },
    description: 'Tasks of a project. Extra query filters: `status`, `priority`, `assigneeId`, `dueFrom`, `dueTo` (dates inclusive).',
  },
  createProjectTask: {
    successStatus: 201, response: task, responseName: 'Task',
    requestExamples: { simple: { title: 'Draft homepage copy', priority: 'high', dueDate: '2026-03-20' } },
    description: 'Creates a task in column `todo` at the bottom. `assigneeId` must be an active member; `parentTaskId` and `milestoneId` must belong to the same project. Emits `task.created` (and `task.assigned`).',
  },
  getTaskById: {
    response: task.extend({
      subtasks: z.array(task).describe('Direct sub-tasks ordered by position.'),
      dependsOn: z.array(uuid).describe('Ids of tasks that must be finished first.'),
    }),
    responseName: 'TaskDetail', description: 'A task with its sub-tasks and dependency ids. A task of a project you cannot access returns `404`.',
  },
  updateTask: {
    successStatus: 200, response: task, responseName: 'Task', errors: [412],
    description: 'Partial update. Send `rowVersion` to detect concurrent edits (`412`). An empty body returns `422`; a task cannot be its own parent (`409`).',
  },
  deleteTask: { successStatus: 204, description: 'Soft-deletes the task.' },
  moveTask: {
    successStatus: 200, response: task, responseName: 'Task', errors: [412],
    requestExamples: { toReview: { status: 'in_review', afterTaskId: null } },
    description: 'Moves a task to another column and/or position (Kanban). `afterTaskId` places it after that task in the target column; `null` puts it first. Status changes follow the organization\'s published `task` workflow when present, otherwise the default transitions; a task with unfinished dependencies cannot become `done` (`409`).',
  },
  getProjectBoard: {
    response: z.object({ columns: z.array(z.object({ status: taskStatus, tasks: z.array(task).describe('Tasks in this column ordered by position.') })).describe('One column per status, in Kanban order.') }),
    responseName: 'ProjectBoard', description: 'All non-deleted tasks grouped by status.',
  },
  createTaskComment: {
    successStatus: 201, response: z.object({ id: uuid.describe('Comment id.'), body: z.string().describe('Comment text.') }),
    description: 'Adds a comment. Requires project role `viewer` or higher plus `tasks:comment`.',
  },
  listTaskComments: {
    response: z.object({
      id: uuid.describe('Comment id.'), body: z.string().describe('Text.'), createdAt: isoDate.describe('Posted at.'),
      authorId: uuid.describe('Author user id.'), authorName: z.string().describe('Author display name.'),
    }),
    responseName: 'TaskComment', collection: true, description: 'Comments of a task, oldest first.',
  },
  deleteTaskComment: { successStatus: 204, description: 'Deletes the **caller\'s own** comment; others\' comments return `404`.' },
  attachFileToTask: {
    successStatus: 201, errors: [409], response: z.object({ id: uuid.describe('Attachment id.'), fileId: uuid.describe('Attached file.') }),
    description: 'Attaches a previously uploaded file (`uploadFile`). Attaching the same file twice returns `409`.',
  },
  listTaskAttachments: {
    response: z.object({
      id: uuid.describe('Attachment id.'), fileId: uuid.describe('File id.'), originalFilename: z.string().describe('File name.'),
      contentType: z.string().describe('MIME type.'), size: z.string().describe('Size in bytes (decimal string).'), scanStatus: z.string().describe('Malware scan status.'),
    }),
    responseName: 'TaskAttachment', collection: true, description: 'Files attached to the task.',
  },
  addTaskDependency: {
    successStatus: 201, errors: [409], response: z.object({ taskId: uuid.describe('Dependent task.'), dependsOnTaskId: uuid.describe('Prerequisite task.') }),
    description: 'Declares that the task depends on another. Self-dependencies and cycles are rejected (`409`).',
  },
  removeTaskDependency: { successStatus: 204, description: 'Removes a dependency.' },
  listTaskActivity: {
    response: rowOf('task_activity'), responseName: 'TaskActivity',
    list: { sortable: ['occurred_at'], filterable: [], defaultSort: '-occurred_at', searchable: false },
    description: 'Append-only activity feed (created, updated with field diffs, moved, commented...).',
  },
  createProjectRecurringRule: {
    successStatus: 201,
    response: z.object({
      id: uuid.describe('Rule id.'), title: z.string().describe('Title of generated tasks.'), frequency: z.enum(['daily', 'weekly', 'monthly']).describe('Repeat unit.'),
      intervalCount: z.number().int().describe('Every N units.'), nextRunOn: z.string().describe('First generation date.'),
    }).loose(),
    responseName: 'RecurringTaskRuleCreated',
    description: 'Creates a rule that generates a task on each occurrence date (idempotent per rule and date). Requires project role `lead`.',
  },
  listProjectRecurringRules: { response: recurring, responseName: 'RecurringTaskRule', collection: true, description: 'Recurring rules of the project.' },
  deleteRecurringRule: { successStatus: 204, description: 'Deactivates the rule (it is not deleted); already generated tasks stay.' },
  listProjectTemplateTasks: {
    response: z.object({
      id: z.string().uuid().describe('Template task id.'), title: z.string().describe('Task title.'),
      description: z.string().describe('Task description.'), priority: z.enum(['low', 'medium', 'high', 'urgent']).describe('Priority.'),
      offsetDays: z.number().int().describe('Days after the project start date the task is due.'),
      estimateHours: z.number().nullable().describe('Estimated hours, or `null`.'), position: z.number().int().describe('Order in the template.'),
    }),
    responseName: 'ProjectTemplateTask', collection: true,
    description: 'Lists the tasks a template creates, in order. `replaceProjectTemplateTasks` replaces the whole list.',
  },
  replaceProjectTemplateTasks: {
    successStatus: 200, response: z.object({ templateId: uuid.describe('Template id.'), tasks: z.number().int().describe('Number of tasks stored.') }),
    description: 'Replaces the task list of the template (max 500). `offsetDays` is the due date offset from the project start.',
  },
  createProjectFromTemplate: {
    successStatus: 201, response: z.object({ id: uuid.describe('New project id.'), tasks: z.number().int().describe('Tasks created from the template.') }),
    description: 'Creates a project plus its tasks (due dates = `startDate` + `offsetDays`); the caller becomes owner and lead.',
  },
  getProjectProgress: {
    response: z.object({
      projectId: uuid.describe('Project.'), totalTasks: z.number().int().describe('Non-deleted tasks.'), doneTasks: z.number().int().describe('Tasks in `done`.'),
      percentComplete: z.number().describe('Done as % of total (1 decimal).'), byStatus: z.record(z.string(), z.number().int()).describe('Count per status.'),
      estimatedHours: z.number().describe('Sum of task estimates.'), actualHours: z.number().describe('Hours from time entries.'),
      budgetHours: z.number().nullable().describe('Project budget; `null` when not set.'),
    }),
    responseName: 'ProjectProgress', description: 'Task completion plus estimated versus actual hours.',
  },
  getProjectReport: {
    response: z.object({
      overdue: z.number().int().describe('Open tasks past their due date.'),
      byAssignee: z.array(z.object({ assigneeId: uuid.nullable().describe('Assignee; `null` = unassigned.'), count: z.number().int().describe('Tasks.') })).describe('Tasks per assignee.'),
      byPriority: z.record(z.string(), z.number().int()).describe('Tasks per priority.'),
    }),
    responseName: 'ProjectReport', description: 'Overdue work and distribution by assignee and priority.',
  },
});
