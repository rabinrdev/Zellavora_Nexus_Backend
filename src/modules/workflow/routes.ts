import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { evaluate, evaluateBool, validateLogic, LogicError } from '../../platform/jsonlogic.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { rowToApi, mapDbError } from '../../platform/crud.js';
import type { Trx } from '../../platform/scope.js';

const M = 'workflow';
const FLAG = 'module.workflow';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const stateSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), label: z.string().max(80), final: z.boolean().default(false) });
const transitionSchema = z.object({
  from: z.string(), to: z.string(), action: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  condition: z.unknown().optional(), requiredPermission: z.string().max(80).optional(),
  assignRole: z.string().max(60).optional(), dueHours: z.number().int().min(1).max(24 * 90).optional(),
});
const ruleSchema = z.object({ name: z.string().max(80), when: z.unknown(), then: z.record(z.string(), z.unknown()).default({}) });
const versionBody = z.object({
  initialState: z.string(), states: z.array(stateSchema).min(2).max(50),
  transitions: z.array(transitionSchema).min(1).max(300), rules: z.array(ruleSchema).max(100).default([]),
});

export function checkDefinition(v: z.infer<typeof versionBody>): void {
  const keys = new Set(v.states.map((s) => s.key));
  const issues: { field: string; issue: string }[] = [];
  if (keys.size !== v.states.length) issues.push({ field: 'states', issue: 'duplicate state keys' });
  if (!keys.has(v.initialState)) issues.push({ field: 'initialState', issue: 'unknown state' });
  if (!v.states.some((s) => s.final)) issues.push({ field: 'states', issue: 'at least one final state is required' });
  const seen = new Set<string>();
  for (const [i, t] of v.transitions.entries()) {
    if (!keys.has(t.from) || !keys.has(t.to)) issues.push({ field: `transitions.${i}`, issue: 'unknown state' });
    const id = `${t.from}:${t.action}`;
    if (seen.has(id)) issues.push({ field: `transitions.${i}`, issue: 'duplicate action for state' });
    seen.add(id);
    if (v.states.find((s) => s.key === t.from)?.final) issues.push({ field: `transitions.${i}`, issue: 'final states cannot have outgoing transitions' });
    try { if (t.condition !== undefined) validateLogic(t.condition); } catch (e) { issues.push({ field: `transitions.${i}.condition`, issue: (e as Error).message }); }
  }
  v.rules.forEach((r, i) => { try { validateLogic(r.when); } catch (e) { issues.push({ field: `rules.${i}.when`, issue: (e as Error).message }); } });
  // reachability from initial state
  const reach = new Set([v.initialState]);
  for (let n = 0; n < v.states.length; n++) for (const t of v.transitions) if (reach.has(t.from)) reach.add(t.to);
  for (const s of v.states) if (!reach.has(s.key)) issues.push({ field: 'states', issue: `state "${s.key}" is unreachable` });
  if (issues.length) throw new AppError('VALIDATION_FAILED', 'Invalid workflow definition', issues);
}

export interface PublishedVersion {
  id: string; initial_state: string; states: { key: string; final: boolean }[];
  transitions: { from: string; to: string; action: string; condition?: unknown; requiredPermission?: string }[];
}

export async function publishedVersion(trx: Trx, organizationId: string, definitionKey: string): Promise<PublishedVersion | null> {
  const row = await trx('workflow_versions as v').join('workflow_definitions as d', 'd.id', 'v.definition_id')
    .where({ 'd.organization_id': organizationId, 'd.key': definitionKey, 'v.status': 'published' }).select('v.*').first();
  return row ?? null;
}

/** Used by modules (tasks, approvals…) to honour an organization's configured transitions. */
export async function transitionAllowed(
  trx: Trx, organizationId: string, definitionKey: string, from: string, to: string, data: unknown, perms: ReadonlySet<string>,
): Promise<boolean | null> {
  const v = await publishedVersion(trx, organizationId, definitionKey);
  if (!v) return null; // no configured workflow: caller applies its default
  return v.transitions.some((t) => t.from === from && t.to === to &&
    (!t.requiredPermission || perms.has(t.requiredPermission)) && (t.condition === undefined || evaluateBool(t.condition, data)));
}

defineRoute({
  method: 'get', path: '/workflows', module: M, moduleFlag: FLAG, summary: 'List workflow definitions',
  access: { permission: 'workflows:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('workflow_definitions').where({ organization_id: c.orgId() });
    const page = await paginate(qb, c.query as ListQuery, { sortable: { name: 'name', created_at: 'created_at' }, filterable: { entity_type: 'entity_type' }, defaultSort: 'name' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/workflows', module: M, moduleFlag: FLAG, summary: 'Create a workflow definition',
  access: { permission: 'workflows:create' },
  body: z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]{2,60}$/), name: z.string().trim().min(2).max(120), entityType: z.string().max(60), description: z.string().max(500).default('') }),
  response: obj, audit: { action: 'workflow.created', resourceType: 'workflow' },
  async handler(c) {
    const id = newId();
    try {
      await c.trx('workflow_definitions').insert({
        id, organization_id: c.orgId(), key: c.body.key, name: c.body.name, entity_type: c.body.entityType,
        description: c.body.description, created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    } catch (e) { throw mapDbError(e); }
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'get', path: '/workflows/:id', module: M, moduleFlag: FLAG, summary: 'Workflow definition with versions',
  access: { permission: 'workflows:read' }, params: idParams, response: obj,
  async handler(c) {
    const d = await c.trx('workflow_definitions').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!d) throw new AppError('NOT_FOUND', 'Workflow not found');
    const versions = await c.trx('workflow_versions').where({ definition_id: d.id }).orderBy('version', 'desc');
    return { data: { ...rowToApi(d), versions: versions.map((v) => rowToApi(v)) } };
  },
});

defineRoute({
  method: 'post', path: '/workflows/:id/versions', module: M, moduleFlag: FLAG, summary: 'Create a draft version',
  access: { permission: 'workflows:update' }, params: idParams, body: versionBody, response: obj,
  audit: { action: 'workflow.version_created', resourceType: 'workflow' },
  async handler(c) {
    const d = await c.trx('workflow_definitions').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!d) throw new AppError('NOT_FOUND', 'Workflow not found');
    checkDefinition(c.body);
    const last = await c.trx('workflow_versions').where({ definition_id: d.id }).max({ v: 'version' }).first();
    const version = Number((last as { v: number | null }).v ?? 0) + 1;
    const id = newId();
    await c.trx('workflow_versions').insert({
      id, organization_id: c.orgId(), definition_id: d.id, version, initial_state: c.body.initialState,
      states: JSON.stringify(c.body.states), transitions: JSON.stringify(c.body.transitions), rules: JSON.stringify(c.body.rules), created_by: c.auth!.userId,
    });
    return { status: 201, data: { id, version, status: 'draft' }, auditResourceId: d.id };
  },
});

defineRoute({
  method: 'put', path: '/workflows/versions/:id', module: M, moduleFlag: FLAG, summary: 'Replace a draft version (published versions are immutable)',
  access: { permission: 'workflows:update' }, params: idParams, body: versionBody, response: obj,
  audit: { action: 'workflow.version_updated', resourceType: 'workflow_version' },
  async handler(c) {
    const v = await c.trx('workflow_versions').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!v) throw new AppError('NOT_FOUND', 'Version not found');
    if (v.status !== 'draft') throw new AppError('CONFLICT', 'Only draft versions can be edited');
    checkDefinition(c.body);
    await c.trx('workflow_versions').where({ id: v.id }).update({
      initial_state: c.body.initialState, states: JSON.stringify(c.body.states), transitions: JSON.stringify(c.body.transitions), rules: JSON.stringify(c.body.rules),
    });
    return { status: 200, data: { id: v.id, status: 'draft' } };
  },
});

defineRoute({
  method: 'post', path: '/workflows/versions/:id/publish', module: M, moduleFlag: FLAG, summary: 'Publish a version (becomes immutable)',
  access: { permission: 'workflows:publish' }, params: idParams, response: obj,
  audit: { action: 'workflow.version_published', resourceType: 'workflow_version' },
  async handler(c) {
    const v = await c.trx('workflow_versions').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!v) throw new AppError('NOT_FOUND', 'Version not found');
    if (v.status !== 'draft') throw new AppError('CONFLICT', 'Version is not a draft');
    checkDefinition({ initialState: v.initial_state, states: v.states, transitions: v.transitions, rules: v.rules });
    await c.trx('workflow_versions').where({ definition_id: v.definition_id, status: 'published' }).update({ status: 'retired' });
    await c.trx('workflow_versions').where({ id: v.id }).update({ status: 'published', published_at: c.svc.now() });
    return { status: 200, data: { id: v.id, status: 'published', version: v.version } };
  },
});

defineRoute({
  method: 'post', path: '/workflows/rules/test', module: M, moduleFlag: FLAG, summary: 'Dry-run a rule expression',
  access: { permission: 'workflows:read' }, body: z.object({ expression: z.unknown(), data: z.record(z.string(), z.unknown()).default({}) }), response: obj,
  async handler(c) {
    try {
      return { status: 200, data: { result: evaluate(c.body.expression, c.body.data) } };
    } catch (e) {
      if (e instanceof LogicError) throw new AppError('VALIDATION_FAILED', 'Invalid rule', [{ field: 'expression', issue: e.message }]);
      throw e;
    }
  },
});

defineRoute({
  method: 'post', path: '/workflows/:id/instances', module: M, moduleFlag: FLAG, summary: 'Start an instance on the published version',
  access: { permission: 'workflows:execute' }, params: idParams, idempotent: true,
  body: z.object({ subjectType: z.string().max(60), subjectId: uuid, context: z.record(z.string(), z.unknown()).default({}) }),
  response: obj, audit: { action: 'workflow.instance_started', resourceType: 'workflow_instance' },
  async handler(c) {
    const d = await c.trx('workflow_definitions').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!d) throw new AppError('NOT_FOUND', 'Workflow not found');
    const v = await c.trx('workflow_versions').where({ definition_id: d.id, status: 'published' }).first();
    if (!v) throw new AppError('CONFLICT', 'The workflow has no published version');
    const id = newId();
    await c.trx('workflow_instances').insert({
      id, organization_id: c.orgId(), definition_id: d.id, version_id: v.id, subject_type: c.body.subjectType,
      subject_id: c.body.subjectId, state: v.initial_state, context: JSON.stringify(c.body.context), created_by: c.auth!.userId,
    });
    await c.trx('workflow_actions').insert({ id: newId(), organization_id: c.orgId(), instance_id: id, from_state: null, to_state: v.initial_state, action: 'start', actor_id: c.auth!.userId });
    return { status: 201, data: { id, state: v.initial_state, versionId: v.id } };
  },
});

defineRoute({
  method: 'post', path: '/workflows/instances/:id/transition', module: M, moduleFlag: FLAG, summary: 'Apply an action to an instance',
  access: { permission: 'workflows:execute' }, params: idParams, idempotent: true,
  body: z.object({ action: z.string().max(60), payload: z.record(z.string(), z.unknown()).default({}), rowVersion: z.number().int().optional() }),
  response: obj, audit: { action: 'workflow.transitioned', resourceType: 'workflow_instance' },
  async handler(c) {
    const inst = await c.trx('workflow_instances').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!inst) throw new AppError('NOT_FOUND', 'Instance not found');
    if (c.body.rowVersion !== undefined && c.body.rowVersion !== inst.row_version) throw new AppError('PRECONDITION_FAILED', 'Instance was modified; reload and retry');
    if (inst.status !== 'active') throw new AppError('CONFLICT', 'Instance is not active');
    const v = await c.trx('workflow_versions').where({ id: inst.version_id }).first(); // pinned version
    const t = (v.transitions as { from: string; to: string; action: string; condition?: unknown; requiredPermission?: string }[])
      .find((x) => x.from === inst.state && x.action === c.body.action);
    if (!t) throw new AppError('CONFLICT', `Action "${c.body.action}" is not allowed from state "${inst.state}"`);
    if (t.requiredPermission && !c.auth!.permissions.has(t.requiredPermission)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
    const data = { context: inst.context, payload: c.body.payload, actor: { id: c.auth!.userId } };
    if (t.condition !== undefined) {
      let ok = false;
      try { ok = evaluateBool(t.condition, data); }
      catch (e) {
        await c.trx('workflow_failures').insert({ id: newId(), organization_id: c.orgId(), instance_id: inst.id, action: c.body.action, error: (e as Error).message.slice(0, 500) });
        throw new AppError('CONFLICT', 'Transition condition could not be evaluated');
      }
      if (!ok) throw new AppError('CONFLICT', 'Transition condition not satisfied');
    }
    const final = (v.states as { key: string; final: boolean }[]).find((s) => s.key === t.to)?.final === true;
    await c.trx('workflow_instances').where({ id: inst.id }).update({
      state: t.to, status: final ? 'completed' : 'active', updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1'),
    });
    await c.trx('workflow_actions').insert({
      id: newId(), organization_id: c.orgId(), instance_id: inst.id, from_state: inst.state, to_state: t.to,
      action: c.body.action, actor_id: c.auth!.userId, payload: JSON.stringify(c.body.payload),
    });
    await c.emit('workflow.transitioned', { instanceId: inst.id, from: inst.state, to: t.to, subjectType: inst.subject_type, subjectId: inst.subject_id });
    return { status: 200, data: { id: inst.id, state: t.to, status: final ? 'completed' : 'active' } };
  },
});

defineRoute({
  method: 'get', path: '/workflows/instances/:id', module: M, moduleFlag: FLAG, summary: 'Instance with action history',
  access: { permission: 'workflows:read' }, params: idParams, response: obj,
  async handler(c) {
    const inst = await c.trx('workflow_instances').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!inst) throw new AppError('NOT_FOUND', 'Instance not found');
    const history = await c.trx('workflow_actions').where({ instance_id: inst.id }).orderBy('occurred_at');
    return { data: { ...rowToApi(inst), history: history.map((h) => rowToApi(h)) } };
  },
});

defineRoute({
  method: 'get', path: '/workflows/failures', module: M, moduleFlag: FLAG, summary: 'Failed rule/action evaluations',
  access: { permission: 'workflows:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('workflow_failures').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { occurred_at: 'occurred_at' }, filterable: { status: 'status' }, defaultSort: '-occurred_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/workflows/failures/:id/retry', module: M, moduleFlag: FLAG, summary: 'Mark a failure resolved after correction',
  access: { permission: 'workflows:execute' }, params: idParams, response: obj,
  async handler(c) {
    const n = await c.trx('workflow_failures').where({ id: c.params.id, organization_id: c.orgId(), status: 'open' }).update({ status: 'resolved', resolved_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Open failure not found');
    return { status: 200, data: { id: c.params.id, status: 'resolved' } };
  },
});
