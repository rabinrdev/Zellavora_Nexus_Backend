import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const request = rowOf('approval_requests');
const decisionResult = z.object({
  id: uuid.describe('Approval request id.'),
  status: z.enum(['pending', 'approved', 'rejected', 'changes_requested']).describe('Request status after the decision (`pending` while more approvals are needed).'),
});

documentRoutes({
  createApprovalTemplate: {
    successStatus: 201, response: rowOf('approval_templates'), responseName: 'ApprovalTemplate',
    description: 'Defines the steps (each with approvers by user, role or manager and a quorum) used by `createApprovalRequest`.',
  },
  listApprovalTemplates: { response: rowOf('approval_templates'), responseName: 'ApprovalTemplate', collection: true, description: 'Active approval templates.' },
  replaceApprovalTemplate: {
    successStatus: 200, response: z.object({ id: uuid.describe('Template id.') }),
    description: 'Updates name, steps, self-approval prevention or the active flag.',
  },
  createApprovalRequest: {
    successStatus: 201, response: z.object({ id: uuid.describe('Request id.'), status: z.literal('pending').describe('Initial status.') }),
    description: 'Creates a request from a template (`templateKey`). Approvers are resolved at creation and notified.',
  },
  listApprovalInbox: {
    response: request, responseName: 'ApprovalRequest', list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false },
    description: 'Requests waiting for the caller\'s decision (including delegated ones).',
  },
  listApprovalHistory: {
    response: request, responseName: 'ApprovalRequest', list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false },
    description: 'Requests the caller created or decided.',
  },
  getApprovalRequestById: {
    response: request.extend({
      steps: z.array(rowOf('approval_steps').extend({
        approvers: z.array(z.object({ userId: uuid.describe('Approver.'), via: z.string().describe('How the approver was resolved: user, role, manager or delegation.') })).describe('Approvers of the step.'),
      })).describe('Steps in order.'),
      decisions: z.array(rowOf('approval_decisions')).describe('Decision history.'),
    }),
    responseName: 'ApprovalRequestDetail', description: 'Request with steps and decisions. Only participants (requester, approvers) may read it; others get `404`.',
  },
  approveApprovalRequest: { successStatus: 200, response: decisionResult, errors: [409], description: 'Records an approval. The request completes when the quorum of every step is reached. Self-approval may be prevented (`403`).' },
  rejectApprovalRequest: { successStatus: 200, response: decisionResult, errors: [409], description: 'Rejects the request; it ends as `rejected`.' },
  requestApprovalChanges: { successStatus: 200, response: decisionResult, errors: [409], description: 'Sends the request back to the requester (`changes_requested`); use `resubmitApprovalRequest` afterwards.' },
  reassignApprovalRequest: {
    successStatus: 200, response: z.object({ id: uuid.describe('Request id.'), reassignedTo: uuid.describe('New approver.') }),
    description: 'Hands the caller\'s approval to another active member.',
  },
  cancelApprovalRequest: { successStatus: 200, response: z.object({ id: uuid.describe('Request id.'), status: z.literal('cancelled').describe('New status.') }), description: 'The requester cancels a pending request.' },
  resubmitApprovalRequest: { successStatus: 200, response: z.object({ id: uuid.describe('Request id.'), status: z.literal('pending').describe('New status.') }), description: 'Resubmits after changes were requested, optionally with an updated `payload`.' },
  createApprovalDelegation: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Delegation id.'), delegateId: uuid.describe('Delegate.'), startsAt: z.string().describe('Start (ISO-8601).'), endsAt: z.string().describe('End (ISO-8601).') }),
    description: 'Lets another member decide on the caller\'s behalf during the period.',
  },
  deleteApprovalDelegation: { successStatus: 204, description: 'Revokes a delegation immediately.' },
});
