import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { rowToApi, mapDbError } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { registerWidget } from '../dashboard/registry.js';
import type { Services } from '../../platform/types.js';

const M = 'approvals';
const FLAG = 'module.approvals';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const approverSpec = z.union([
  z.object({ type: z.literal('user'), id: uuid }),
  z.object({ type: z.literal('role'), key: z.string().max(60) }),
]);
const stepSpec = z.object({
  mode: z.enum(['any', 'all', 'quorum']).default('any'),
  quorum: z.number().int().min(1).max(50).default(1),
  approvers: z.array(approverSpec).min(1).max(50),
  dueHours: z.number().int().min(1).max(24 * 60).default(72),
  escalateTo: uuid.optional(),
});
type StepSpec = z.infer<typeof stepSpec>;

async function resolveApprovers(trx: Trx, orgId: string, step: StepSpec, requesterId: string, preventSelf: boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>(); // userId -> via
  for (const a of step.approvers) {
    if (a.type === 'user') {
      const m = await trx('organization_memberships').where({ organization_id: orgId, user_id: a.id, status: 'active' }).first();
      if (m) out.set(a.id, 'direct');
    } else {
      const rows = await trx('user_role_assignments as ura').join('roles as r', 'r.id', 'ura.role_id')
        .join('organization_memberships as m', 'm.id', 'ura.membership_id')
        .where({ 'ura.organization_id': orgId, 'm.status': 'active', 'r.key': a.key, 'ura.scope_type': 'organization' }).select('m.user_id');
      for (const r of rows) out.set(r.user_id, `role:${a.key}`);
    }
  }
  // delegations: active delegate may act for the delegator
  const now = new Date();
  for (const uid of [...out.keys()]) {
    const dels = await trx('approval_delegations').where({ organization_id: orgId, delegator_id: uid, active: true }).where('starts_at', '<=', now).where('ends_at', '>', now);
    for (const d of dels) if (!out.has(d.delegate_id)) out.set(d.delegate_id, `delegate:${uid}`);
  }
  if (preventSelf) out.delete(requesterId);
  return out;
}

export interface CreateApproval {
  templateId?: string | null;
  subjectType: string;
  subjectId?: string | null;
  title: string;
  steps: StepSpec[];
  payload?: Record<string, unknown>;
  preventSelfApproval: boolean;
}

/** Creates the request and activates step 1. Runs inside the caller's tenant transaction. */
export async function createApproval(
  trx: Trx, svc: Services, orgId: string, requesterId: string, input: CreateApproval,
): Promise<{ id: string }> {
  const id = newId();
  await trx('approval_requests').insert({
    id, organization_id: orgId, template_id: input.templateId ?? null, subject_type: input.subjectType, subject_id: input.subjectId ?? null,
    title: input.title, requester_id: requesterId, payload: JSON.stringify(input.payload ?? {}),
    prevent_self_approval: input.preventSelfApproval, created_by: requesterId, updated_by: requesterId,
  });
  for (const [i, spec] of input.steps.entries()) {
    const approvers = await resolveApprovers(trx, orgId, spec, requesterId, input.preventSelfApproval);
    if (approvers.size === 0) {
      throw new AppError('VALIDATION_FAILED', `Step ${i + 1} has no eligible approvers`, [{ field: `steps.${i}.approvers`, issue: 'no_eligible_approvers' }]);
    }
    const quorum = spec.mode === 'all' ? approvers.size : spec.mode === 'any' ? 1 : Math.min(spec.quorum, approvers.size);
    const stepId = newId();
    await trx('approval_steps').insert({
      id: stepId, organization_id: orgId, request_id: id, step_order: i + 1, mode: spec.mode, quorum,
      status: i === 0 ? 'active' : 'waiting', due_at: i === 0 ? new Date(svc.now().getTime() + spec.dueHours * 3600_000) : null,
      escalate_to: spec.escalateTo ?? null,
    });
    await trx('approval_step_approvers').insert([...approvers].map(([user_id, via]) => ({ id: newId(), organization_id: orgId, step_id: stepId, user_id, via })));
  }
  const first = await trx('approval_steps as s').join('approval_step_approvers as a', 'a.step_id', 's.id')
    .where({ 's.request_id': id, 's.step_order': 1 }).select('a.user_id');
  await svc.events.emit(trx, 'approval.requested', orgId, {
    requestId: id, title: input.title, approverIds: first.map((r) => r.user_id), requesterId, subjectType: input.subjectType, subjectId: input.subjectId ?? null,
  });
  return { id };
}

async function finish(trx: Trx, svc: Services, orgId: string, req: Record<string, unknown>, status: 'approved' | 'rejected' | 'changes_requested' | 'cancelled', actorId: string) {
  await trx('approval_requests').where({ id: req.id }).update({
    status, completed_at: svc.now(), updated_at: svc.now(), updated_by: actorId, row_version: trx.raw('row_version + 1'),
  });
  await svc.events.emit(trx, `approval.${status}`, orgId, {
    requestId: req.id, title: req.title, requesterId: req.requester_id, subjectType: req.subject_type, subjectId: req.subject_id, decidedBy: actorId,
  });
}

/** One decision, safe under concurrency (row lock on the request + unique(step, approver)). */
export async function decide(
  trx: Trx, svc: Services, orgId: string, actorId: string, requestId: string,
  decision: 'approve' | 'reject' | 'request_changes', comment?: string,
): Promise<{ status: string }> {
  const req = await trx('approval_requests').where({ id: requestId, organization_id: orgId }).forUpdate().first();
  if (!req) throw new AppError('NOT_FOUND', 'Approval request not found');
  if (req.status !== 'pending') throw new AppError('CONFLICT', `Request is already ${req.status}`);
  if (req.prevent_self_approval && req.requester_id === actorId) throw new AppError('FORBIDDEN', 'You cannot decide your own request');
  const step = await trx('approval_steps').where({ request_id: req.id, status: 'active' }).forUpdate().first();
  if (!step) throw new AppError('CONFLICT', 'No active step');
  const isApprover = await trx('approval_step_approvers').where({ step_id: step.id, user_id: actorId }).first();
  if (!isApprover) throw new AppError('NOT_FOUND', 'Approval request not found'); // non-participants learn nothing
  try {
    await trx('approval_decisions').insert({ id: newId(), organization_id: orgId, request_id: req.id, step_id: step.id, approver_id: actorId, decision, comment: comment ?? null, round: req.round });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError('CONFLICT', 'You have already decided this step');
    throw e;
  }
  if (decision === 'reject') {
    await trx('approval_steps').where({ id: step.id }).update({ status: 'rejected' });
    await finish(trx, svc, orgId, req, 'rejected', actorId);
    return { status: 'rejected' };
  }
  if (decision === 'request_changes') {
    await finish(trx, svc, orgId, req, 'changes_requested', actorId);
    return { status: 'changes_requested' };
  }
  const approvals = Number(((await trx('approval_decisions').where({ step_id: step.id, decision: 'approve', round: req.round }).count({ c: '*' }).first()) as { c: string }).c);
  if (approvals < step.quorum) return { status: 'pending' };
  await trx('approval_steps').where({ id: step.id }).update({ status: 'approved' });
  const next = await trx('approval_steps').where({ request_id: req.id, step_order: step.step_order + 1 }).first();
  if (!next) {
    await finish(trx, svc, orgId, req, 'approved', actorId);
    return { status: 'approved' };
  }
  const tpl = req.template_id ? await trx('approval_templates').where({ id: req.template_id }).first() : null;
  const dueHours = (tpl?.steps as StepSpec[] | undefined)?.[next.step_order - 1]?.dueHours ?? 72;
  await trx('approval_steps').where({ id: next.id }).update({ status: 'active', due_at: new Date(svc.now().getTime() + dueHours * 3600_000) });
  await trx('approval_requests').where({ id: req.id }).update({ current_step: next.step_order, updated_at: svc.now() });
  const nextApprovers = await trx('approval_step_approvers').where({ step_id: next.id }).select('user_id');
  await svc.events.emit(trx, 'approval.requested', orgId, {
    requestId: req.id, title: req.title, approverIds: nextApprovers.map((a) => a.user_id), requesterId: req.requester_id,
    subjectType: req.subject_type, subjectId: req.subject_id,
  });
  return { status: 'pending' };
}

// ---- templates -----------------------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/approval-templates', module: M, moduleFlag: FLAG, summary: 'Create an approval template',
  access: { permission: 'approval_templates:create' },
  body: z.object({
    key: z.string().regex(/^[a-z][a-z0-9_.]{2,60}$/), name: z.string().trim().min(2).max(120), subjectType: z.string().max(60),
    steps: z.array(stepSpec).min(1).max(10), preventSelfApproval: z.boolean().default(true),
  }), response: obj, audit: { action: 'approval_template.created', resourceType: 'approval_template' },
  async handler(c) {
    const id = newId();
    try {
      await c.trx('approval_templates').insert({
        id, organization_id: c.orgId(), key: c.body.key, name: c.body.name, subject_type: c.body.subjectType,
        steps: JSON.stringify(c.body.steps), prevent_self_approval: c.body.preventSelfApproval, created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    } catch (e) { throw mapDbError(e); }
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'get', path: '/approval-templates', module: M, moduleFlag: FLAG, summary: 'List approval templates',
  access: { permission: 'approval_templates:read' }, response: obj,
  async handler(c) {
    return { data: (await c.trx('approval_templates').where({ organization_id: c.orgId(), active: true }).orderBy('name')).map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'put', path: '/approval-templates/:id', module: M, moduleFlag: FLAG, summary: 'Update template approvers/steps',
  access: { permission: 'approval_templates:update' }, params: idParams,
  body: z.object({ name: z.string().trim().min(2).max(120).optional(), steps: z.array(stepSpec).min(1).max(10).optional(), preventSelfApproval: z.boolean().optional(), active: z.boolean().optional() }),
  response: obj, audit: { action: 'approval_template.updated', resourceType: 'approval_template' },
  async handler(c) {
    const patch: Record<string, unknown> = {};
    if (c.body.name) patch.name = c.body.name;
    if (c.body.steps) patch.steps = JSON.stringify(c.body.steps);
    if (c.body.preventSelfApproval !== undefined) patch.prevent_self_approval = c.body.preventSelfApproval;
    if (c.body.active !== undefined) patch.active = c.body.active;
    if (Object.keys(patch).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update');
    const n = await c.trx('approval_templates').where({ id: c.params.id, organization_id: c.orgId() })
      .update({ ...patch, updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') });
    if (!n) throw new AppError('NOT_FOUND', 'Template not found');
    return { status: 200, data: { id: c.params.id } };
  },
});

// ---- requests -----------------------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/approvals', module: M, moduleFlag: FLAG, summary: 'Create an approval request from a template',
  access: { permission: 'approvals:create' }, idempotent: true,
  body: z.object({ templateKey: z.string().max(60), subjectType: z.string().max(60).optional(), subjectId: uuid.optional(), title: z.string().trim().min(2).max(200), payload: z.record(z.string(), z.unknown()).default({}) }),
  response: obj, audit: { action: 'approval.requested', resourceType: 'approval' },
  async handler(c) {
    const tpl = await c.trx('approval_templates').where({ organization_id: c.orgId(), key: c.body.templateKey, active: true }).first();
    if (!tpl) throw new AppError('NOT_FOUND', 'Approval template not found');
    const orgPrev = (await c.trx('organization_settings').where({ organization_id: c.orgId(), key: 'approvals.prevent_self_approval' }).first())?.value;
    const created = await createApproval(c.trx, c.svc, c.orgId(), c.auth!.userId, {
      templateId: tpl.id, subjectType: c.body.subjectType ?? tpl.subject_type, subjectId: c.body.subjectId, title: c.body.title,
      steps: tpl.steps, payload: c.body.payload, preventSelfApproval: orgPrev === false ? false : tpl.prevent_self_approval,
    });
    return { status: 201, data: { id: created.id, status: 'pending' } };
  },
});

defineRoute({
  method: 'get', path: '/approvals/inbox', module: M, moduleFlag: FLAG, summary: 'Requests awaiting my decision',
  access: { permission: 'approvals:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('approval_requests as r').join('approval_steps as s', function () { this.on('s.request_id', 'r.id').andOnVal('s.status', 'active'); })
      .join('approval_step_approvers as a', 'a.step_id', 's.id')
      .where({ 'r.organization_id': c.orgId(), 'r.status': 'pending', 'a.user_id': c.auth!.userId })
      .whereNotExists(c.trx('approval_decisions as d').whereRaw('d.step_id = s.id AND d.approver_id = a.user_id').select(c.trx.raw('1')))
      .select('r.id', 'r.title', 'r.subject_type', 'r.subject_id', 'r.requester_id', 'r.created_at', 's.due_at');
    const page = await paginate(qb, c.query as ListQuery, { sortable: { created_at: 'r.created_at', due_at: 's.due_at' }, defaultSort: 'created_at', idColumn: 'r.id' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/approvals/history', module: M, moduleFlag: FLAG, summary: 'Requests I created or decided',
  access: { permission: 'approvals:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const uid = c.auth!.userId;
    const qb = c.trx('approval_requests as r').where('r.organization_id', c.orgId())
      .where((w) => w.where('r.requester_id', uid).orWhereExists(c.trx('approval_decisions as d').whereRaw('d.request_id = r.id AND d.approver_id = ?', [uid]).select(c.trx.raw('1'))))
      .select('r.*');
    const page = await paginate(qb, c.query as ListQuery, { sortable: { created_at: 'r.created_at' }, filterable: { status: 'r.status' }, defaultSort: '-created_at', idColumn: 'r.id' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

async function participantRequest(c: HandlerCtx, id: string) {
  const r = await c.trx('approval_requests').where({ id, organization_id: c.orgId() }).first();
  if (!r) throw new AppError('NOT_FOUND', 'Approval request not found');
  const uid = c.auth!.userId;
  if (r.requester_id !== uid && !c.auth!.permissions.has('approvals:manage')) {
    const involved = await c.trx('approval_step_approvers as a').join('approval_steps as s', 's.id', 'a.step_id')
      .where({ 's.request_id': id, 'a.user_id': uid }).first();
    if (!involved) throw new AppError('NOT_FOUND', 'Approval request not found');
  }
  return r;
}

defineRoute({
  method: 'get', path: '/approvals/:id', module: M, moduleFlag: FLAG, summary: 'Request with steps and decision history (participants only)',
  access: { permission: 'approvals:read' }, params: idParams, response: obj,
  async handler(c) {
    const r = await participantRequest(c, c.params.id);
    const steps = await c.trx('approval_steps').where({ request_id: r.id }).orderBy('step_order');
    const approvers = await c.trx('approval_step_approvers').whereIn('step_id', steps.map((s) => s.id));
    const decisions = await c.trx('approval_decisions').where({ request_id: r.id }).orderBy('created_at');
    return {
      data: {
        ...rowToApi(r),
        steps: steps.map((s) => ({ ...rowToApi(s), approvers: approvers.filter((a) => a.step_id === s.id).map((a) => ({ userId: a.user_id, via: a.via })) })),
        decisions: decisions.map((d) => rowToApi(d)),
      },
    };
  },
});

for (const [verb, decision] of [['approve', 'approve'], ['reject', 'reject'], ['request-changes', 'request_changes']] as const) {
  defineRoute({
    method: 'post', path: `/approvals/:id/${verb}`, module: M, moduleFlag: FLAG, summary: `${verb} a request`,
    access: { permission: 'approvals:act' }, params: idParams, idempotent: true,
    body: z.object({ comment: z.string().max(2000).optional() }).default({}), response: obj,
    audit: { action: `approval.${decision}`, resourceType: 'approval' },
    async handler(c) {
      const r = await decide(c.trx, c.svc, c.orgId(), c.auth!.userId, c.params.id, decision, (c.body as { comment?: string }).comment);
      return { status: 200, data: { id: c.params.id, ...r } };
    },
  });
}

defineRoute({
  method: 'post', path: '/approvals/:id/reassign', module: M, moduleFlag: FLAG, summary: 'Reassign my approval to another member',
  access: { permission: 'approvals:act' }, params: idParams, body: z.object({ userId: uuid, comment: z.string().max(500).optional() }), response: obj,
  audit: { action: 'approval.reassigned', resourceType: 'approval' },
  async handler(c) {
    const req = await c.trx('approval_requests').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!req || req.status !== 'pending') throw new AppError('NOT_FOUND', 'Approval request not found');
    const step = await c.trx('approval_steps').where({ request_id: req.id, status: 'active' }).first();
    const mine = step && await c.trx('approval_step_approvers').where({ step_id: step.id, user_id: c.auth!.userId }).first();
    if (!mine) throw new AppError('NOT_FOUND', 'Approval request not found');
    if (req.prevent_self_approval && c.body.userId === req.requester_id) throw new AppError('VALIDATION_FAILED', 'The requester cannot be an approver', [{ field: 'userId', issue: 'requester' }]);
    const m = await c.trx('organization_memberships').where({ organization_id: c.orgId(), user_id: c.body.userId, status: 'active' }).first();
    if (!m) throw new AppError('VALIDATION_FAILED', 'User must be an active member', [{ field: 'userId', issue: 'not_member' }]);
    await c.trx('approval_step_approvers').where({ step_id: step!.id, user_id: c.auth!.userId }).delete();
    await c.trx('approval_step_approvers').insert({ id: newId(), organization_id: c.orgId(), step_id: step!.id, user_id: c.body.userId, via: `reassigned:${c.auth!.userId}` })
      .onConflict(['step_id', 'user_id']).ignore();
    await c.emit('approval.requested', { requestId: req.id, title: req.title, approverIds: [c.body.userId], requesterId: req.requester_id });
    return { status: 200, data: { id: req.id, reassignedTo: c.body.userId } };
  },
});

defineRoute({
  method: 'post', path: '/approvals/:id/cancel', module: M, moduleFlag: FLAG, summary: 'Cancel my pending request',
  access: { permission: 'approvals:create' }, params: idParams, response: obj, audit: { action: 'approval.cancelled', resourceType: 'approval' },
  async handler(c) {
    const r = await c.trx('approval_requests').where({ id: c.params.id, organization_id: c.orgId(), requester_id: c.auth!.userId }).forUpdate().first();
    if (!r) throw new AppError('NOT_FOUND', 'Approval request not found');
    if (r.status !== 'pending') throw new AppError('CONFLICT', `Request is already ${r.status}`);
    await finish(c.trx, c.svc, c.orgId(), r, 'cancelled', c.auth!.userId);
    return { status: 200, data: { id: r.id, status: 'cancelled' } };
  },
});

defineRoute({
  method: 'post', path: '/approvals/:id/resubmit', module: M, moduleFlag: FLAG, summary: 'Resubmit after changes were requested',
  access: { permission: 'approvals:create' }, params: idParams, body: z.object({ payload: z.record(z.string(), z.unknown()).optional() }).default({}),
  response: obj, audit: { action: 'approval.resubmitted', resourceType: 'approval' },
  async handler(c) {
    const r = await c.trx('approval_requests').where({ id: c.params.id, organization_id: c.orgId(), requester_id: c.auth!.userId }).forUpdate().first();
    if (!r) throw new AppError('NOT_FOUND', 'Approval request not found');
    if (r.status !== 'changes_requested') throw new AppError('CONFLICT', 'Only requests with requested changes can be resubmitted');
    const steps = await c.trx('approval_steps').where({ request_id: r.id }).orderBy('step_order');
    for (const s of steps) {
      await c.trx('approval_steps').where({ id: s.id }).update({ status: s.step_order === 1 ? 'active' : 'waiting', due_at: s.step_order === 1 ? new Date(c.svc.now().getTime() + 72 * 3600_000) : null });
    }
    // decisions stay as append-only history; the new round gets its own unique (step, approver, round) rows
    await c.trx('approval_requests').where({ id: r.id }).update({
      status: 'pending', current_step: 1, completed_at: null, round: r.round + 1, payload: JSON.stringify((c.body as { payload?: unknown }).payload ?? r.payload),
      updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1'),
    });
    const first = await c.trx('approval_step_approvers').where({ step_id: steps[0]!.id }).select('user_id');
    await c.emit('approval.requested', { requestId: r.id, title: r.title, approverIds: first.map((a) => a.user_id), requesterId: r.requester_id });
    return { status: 200, data: { id: r.id, status: 'pending' } };
  },
});

// ---- delegations ---------------------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/approvals/delegations', module: M, moduleFlag: FLAG, summary: 'Delegate my approvals for a period',
  access: { permission: 'approvals:act' },
  body: z.object({ delegateId: uuid, startsAt: z.string().datetime(), endsAt: z.string().datetime() }), response: obj,
  audit: { action: 'approval.delegation_created', resourceType: 'approval_delegation' },
  async handler(c) {
    if (c.body.delegateId === c.auth!.userId) throw new AppError('VALIDATION_FAILED', 'Cannot delegate to yourself', [{ field: 'delegateId', issue: 'self' }]);
    if (new Date(c.body.endsAt) <= new Date(c.body.startsAt)) throw new AppError('VALIDATION_FAILED', 'endsAt must be after startsAt', [{ field: 'endsAt', issue: 'before start' }]);
    const m = await c.trx('organization_memberships').where({ organization_id: c.orgId(), user_id: c.body.delegateId, status: 'active' }).first();
    if (!m) throw new AppError('VALIDATION_FAILED', 'Delegate must be an active member', [{ field: 'delegateId', issue: 'not_member' }]);
    const id = newId();
    await c.trx('approval_delegations').insert({ id, organization_id: c.orgId(), delegator_id: c.auth!.userId, delegate_id: c.body.delegateId, starts_at: c.body.startsAt, ends_at: c.body.endsAt });
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'delete', path: '/approvals/delegations/:id', module: M, moduleFlag: FLAG, summary: 'Revoke a delegation',
  access: { permission: 'approvals:act' }, params: idParams,
  async handler(c) {
    const n = await c.trx('approval_delegations').where({ id: c.params.id, organization_id: c.orgId(), delegator_id: c.auth!.userId }).update({ active: false });
    if (!n) throw new AppError('NOT_FOUND', 'Delegation not found');
    return { status: 204 };
  },
});

// ---- overdue escalation + reminders (F-082) ---------------------------------------------------------------------------

export async function processOverdue(svc: Services): Promise<{ escalated: number; reminded: number }> {
  const now = svc.now();
  const active = await withPlatformScope(svc.db, 'approvals-overdue', (t) =>
    t('approval_steps as s').join('approval_requests as r', 'r.id', 's.request_id').where('s.status', 'active').where('r.status', 'pending')
      .whereNotNull('s.due_at').select('s.*', 'r.title', 'r.requester_id'));
  let escalated = 0; let reminded = 0;
  for (const s of active) {
    await withTenant(svc.db, { organizationId: s.organization_id, userId: null }, async (trx) => {
      const due = new Date(s.due_at);
      if (due < now && !s.escalated_at) {
        if (s.escalate_to) {
          await trx('approval_step_approvers').insert({ id: newId(), organization_id: s.organization_id, step_id: s.id, user_id: s.escalate_to, via: 'escalation' }).onConflict(['step_id', 'user_id']).ignore();
        }
        await trx('approval_steps').where({ id: s.id }).update({ escalated_at: now });
        await svc.events.emit(trx, 'approval.overdue', s.organization_id, { requestId: s.request_id, title: s.title, requesterId: s.requester_id, escalatedTo: s.escalate_to ?? null });
        escalated++;
      } else if (due >= now && due.getTime() - now.getTime() < 24 * 3600_000 && !s.reminded_at) {
        const ap = await trx('approval_step_approvers').where({ step_id: s.id }).select('user_id');
        await trx('approval_steps').where({ id: s.id }).update({ reminded_at: now });
        await svc.events.emit(trx, 'approval.reminder', s.organization_id, { requestId: s.request_id, title: s.title, approverIds: ap.map((a) => a.user_id) });
        reminded++;
      }
    });
  }
  return { escalated, reminded };
}

jobRegistrars.push((svc) => {
  svc.jobs.work('reminders', async () => { await processOverdue(svc); });
});

registerWidget({
  key: 'approvals.pending', title: 'Pending approvals', requiredPermission: 'approvals:read', requiredModuleFlag: FLAG,
  async query({ trx, organizationId, userId }) {
    const r = await trx('approval_step_approvers as a').join('approval_steps as s', 's.id', 'a.step_id').join('approval_requests as r', 'r.id', 's.request_id')
      .where({ 'a.organization_id': organizationId, 'a.user_id': userId, 's.status': 'active', 'r.status': 'pending' }).count({ c: '*' }).first();
    return { awaitingMyDecision: Number((r as { c: string }).c) };
  },
});
