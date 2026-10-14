import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const state = z.object({ key: z.string().describe('State key.'), label: z.string().describe('Label.'), final: z.boolean().describe('`true` for end states.') });
const transition = z.object({
  from: z.string().describe('Source state key.'), to: z.string().describe('Target state key.'), action: z.string().describe('Action name sent to `transitionWorkflowInstance`.'),
  condition: z.unknown().optional().describe('JSON-logic condition over `{ context, payload, actor }`.'),
  requiredPermission: z.string().optional().describe('Permission the actor must hold.'),
  assignRole: z.string().optional().describe('Role to assign on entry.'), dueHours: z.number().int().optional().describe('Hours until due.'),
});
const definition = rowOf('workflow_definitions', { describe: { key: 'Stable definition key.', entityType: 'Kind of record the workflow governs.' } });
const version = rowOf('workflow_versions', {
  describe: { status: '`draft`, `published` or `retired` (published versions are immutable).', states: 'Ordered state list.', transitions: 'Allowed transitions.', rules: 'Named rules.' },
  extend: {
    states: z.array(state).describe('States.'), transitions: z.array(transition).describe('Transitions.'),
    rules: z.array(z.object({ name: z.string().describe('Rule name.'), when: z.unknown().describe('JSON-logic expression.'), then: z.record(z.string(), z.unknown()).describe('Effects.') })).describe('Rules.'),
  },
});
const instance = rowOf('workflow_instances', {
  describe: { state: 'Current state key.', status: '`active` or `completed`.', subjectType: 'Kind of record the instance belongs to.', subjectId: 'Id of that record.', context: 'Data supplied at start.' },
});
const miniState = z.object({ id: uuid.describe('Instance id.'), state: z.string().describe('Current state.'), status: z.enum(['active', 'completed']).describe('Instance status.') });

documentRoutes({
  listWorkflows: {
    response: definition, responseName: 'WorkflowDefinition',
    list: { sortable: ['name', 'created_at'], filterable: ['entity_type'], defaultSort: 'name', searchable: false },
    description: 'Workflow definitions of the organization.',
  },
  createWorkflow: {
    successStatus: 201, errors: [409],
    response: z.object({ id: uuid.describe('Definition id.'), key: z.string().describe('Key.'), name: z.string().describe('Name.'), entityType: z.string().describe('Entity type.'), description: z.string().describe('Description.') }),
    description: 'Creates a definition (no behavior until a version is published). `key` must be unique (`409`).',
  },
  getWorkflowById: {
    response: definition.extend({ versions: z.array(version).describe('All versions, newest first.') }), responseName: 'WorkflowDefinitionDetail',
    description: 'Definition with every version.',
  },
  createWorkflowVersion: {
    successStatus: 201, response: z.object({ id: uuid.describe('Version id.'), version: z.number().int().describe('Version number.'), status: z.literal('draft').describe('Always `draft`.') }),
    requestExamples: {
      approvalFlow: {
        initialState: 'submitted',
        states: [{ key: 'submitted', label: 'Submitted', final: false }, { key: 'approved', label: 'Approved', final: true }, { key: 'rejected', label: 'Rejected', final: true }],
        transitions: [{ from: 'submitted', to: 'approved', action: 'approve' }, { from: 'submitted', to: 'rejected', action: 'reject' }],
      },
    },
    description: 'Creates the next draft version. The definition is validated: unique states, a reachable final state, no outgoing transitions from final states and valid JSON-logic (`422` lists every issue).',
  },
  replaceWorkflowVersion: {
    successStatus: 200, response: z.object({ id: uuid.describe('Version id.'), status: z.literal('draft').describe('Still a draft.') }),
    description: 'Replaces the content of a **draft** version. Published versions are immutable (`409`).',
  },
  publishWorkflowVersion: {
    successStatus: 200, response: z.object({ id: uuid.describe('Version id.'), status: z.literal('published').describe('New status.'), version: z.number().int().describe('Version number.') }),
    description: 'Publishes a draft and retires the previously published version. Running instances stay pinned to the version they started on.',
  },
  testWorkflowRule: {
    successStatus: 200, response: z.object({ result: z.unknown().describe('Evaluation result of the expression.') }),
    requestExamples: { greaterThan: { expression: { '>': [{ var: 'payload.amount' }, 1000] }, data: { payload: { amount: 1500 } } } },
    description: 'Dry-runs a JSON-logic expression against sample data. Invalid expressions return `422`.',
  },
  startWorkflowInstance: {
    successStatus: 201, response: z.object({ id: uuid.describe('Instance id.'), state: z.string().describe('Initial state.'), versionId: uuid.describe('Pinned version.') }),
    errors: [409], description: 'Starts an instance on the currently published version. `409` when nothing is published.',
  },
  transitionWorkflowInstance: {
    successStatus: 200, response: miniState, errors: [409, 412],
    description: 'Applies an action. Unknown actions, unsatisfied conditions or inactive instances return `409`; a stale `rowVersion` returns `412`; a missing `requiredPermission` returns `403`. Condition evaluation errors are stored for review (`listWorkflowFailures`).',
  },
  getWorkflowInstanceById: {
    response: instance.extend({ history: z.array(rowOf('workflow_actions')).describe('Actions in chronological order.') }), responseName: 'WorkflowInstanceDetail',
    description: 'Instance with its action history.',
  },
  listWorkflowFailures: {
    response: rowOf('workflow_failures'), responseName: 'WorkflowFailure',
    list: { sortable: ['occurred_at'], filterable: ['status'], defaultSort: '-occurred_at', searchable: false },
    description: 'Rule or condition evaluations that failed.',
  },
  retryWorkflowFailure: {
    successStatus: 200, response: z.object({ id: uuid.describe('Failure id.'), status: z.literal('resolved').describe('New status.') }),
    description: 'Marks an open failure as resolved after the cause was corrected.',
  },
});
