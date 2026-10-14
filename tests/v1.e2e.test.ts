import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getCtx, createActor, loginActor, uniq, type Actor, type TestCtx } from './helpers/app.js';
import { addMember, flush, ROLE } from './helpers/members.js';
import { materializeRecurring } from '../src/modules/projects/routes.js';
import { markOverdueInvoices } from '../src/modules/invoices/routes.js';
import { processOverdue } from '../src/modules/approvals/routes.js';
import { computeLine, sumLines } from '../src/platform/money.js';
import { evaluate } from '../src/platform/jsonlogic.js';
import { withPlatformScope } from '../src/platform/scope.js';

let ctx: TestCtx;
let admin: Actor;
beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
});
afterAll(async () => {
  await ctx.close();
});

const today = () => new Date().toISOString().slice(0, 10);
const monday = (offset = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offset * 7);
  return d.toISOString().slice(0, 10);
};
const day = (start: string, n: number) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('money + rules (unit)', () => {
  it('computes exclusive, inclusive and compound taxes with decimal precision', () => {
    const excl = computeLine({ quantity: '3', unitPrice: '19.99', discountPct: 10, taxes: [{ rate: '8.25', inclusive: false, compound: false }] }, 'USD');
    expect(excl.discount.toFixed(2)).toBe('6.00');
    expect(excl.subtotal.toFixed(2)).toBe('53.97');
    expect(excl.tax.toFixed(2)).toBe('4.45');
    const incl = computeLine({ quantity: '1', unitPrice: '119', discountPct: 0, taxes: [{ rate: '19', inclusive: true, compound: false }] }, 'EUR');
    expect(incl.subtotal.toFixed(2)).toBe('100.00');
    expect(incl.tax.toFixed(2)).toBe('19.00');
    const comp = computeLine({ quantity: '1', unitPrice: '100', discountPct: 0, taxes: [{ rate: '10', inclusive: false, compound: false }, { rate: '5', inclusive: false, compound: true }] }, 'USD');
    expect(comp.tax.toFixed(2)).toBe('15.50'); // 10 + 5% of 110
    expect(sumLines([excl, incl], 'USD').total).toBe(excl.total.plus(incl.total).toFixed(2));
    expect(computeLine({ quantity: '1', unitPrice: '100.4', discountPct: 0, taxes: [] }, 'JPY').total.toString()).toBe('100');
  });

  it('JSON logic is safe and bounded', () => {
    expect(evaluate({ and: [{ '>': [{ var: 'amount' }, 100] }, { in: [{ var: 'dept' }, ['a', 'b']] }] }, { amount: 150, dept: 'a' })).toBe(true);
    expect(() => evaluate({ system: ['rm -rf'] }, {})).toThrow(/Unsupported/);
    expect(() => evaluate({ '/': [1, 0] }, {})).toThrow(/Division/);
    expect(evaluate({ var: '__proto__.polluted' }, {})).toBeNull();
  });
});

describe('teams', () => {
  it('manages members, leaders, history; rejects outsiders', async () => {
    const m = await addMember(ctx, admin, ROLE.member);
    const outsider = await createActor(ctx);
    const team = await ctx.api.post('/api/v1/teams').set(admin.auth).send({ name: `Team ${uniq()}` });
    expect(team.status).toBe(201);
    const id = team.body.data.id;
    expect((await ctx.api.post(`/api/v1/teams/${id}/members`).set(admin.auth).send({ userId: m.userId })).status).toBe(201);
    expect((await ctx.api.post(`/api/v1/teams/${id}/members`).set(admin.auth).send({ userId: m.userId })).status).toBe(409);
    expect((await ctx.api.post(`/api/v1/teams/${id}/members`).set(admin.auth).send({ userId: outsider.userId })).status).toBe(422);
    expect((await ctx.api.put(`/api/v1/teams/${id}/leaders`).set(admin.auth).send({ userIds: [outsider.userId] })).status).toBe(422);
    expect((await ctx.api.put(`/api/v1/teams/${id}/leaders`).set(admin.auth).send({ userIds: [m.userId] })).status).toBe(200);
    const hist = await ctx.api.get(`/api/v1/teams/${id}/history`).set(admin.auth);
    expect(hist.body.data.map((h: { change: string }) => h.change)).toEqual(expect.arrayContaining(['added', 'leader_assigned']));
    const cap = await ctx.api.get(`/api/v1/teams/${id}/capacity`).set(admin.auth);
    expect(cap.status).toBe(200);
  });
});

describe('projects & tasks', () => {
  it('enforces project roles, workflow transitions, dependencies without cycles, and Kanban ordering', async () => {
    const lead = await addMember(ctx, admin, ROLE.member);
    const stranger = await addMember(ctx, admin, ROLE.member);
    const p = await ctx.api.post('/api/v1/projects').set(lead.auth).send({ name: `Proj ${uniq()}`, status: 'active' });
    expect(p.status).toBe(201);
    const pid = p.body.data.id;
    // non-members cannot even see the project (404, not 403)
    expect((await ctx.api.get(`/api/v1/projects/${pid}`).set(stranger.auth)).status).toBe(404);
    expect((await ctx.api.get(`/api/v1/projects/${pid}/tasks`).set(stranger.auth)).status).toBe(404);

    const mk = async (title: string) => (await ctx.api.post(`/api/v1/projects/${pid}/tasks`).set(lead.auth).send({ title })).body.data.id as string;
    const a = await mk('A'); const b = await mk('B'); const c = await mk('C');
    expect((await ctx.api.post(`/api/v1/tasks/${b}/dependencies`).set(lead.auth).send({ dependsOnTaskId: a })).status).toBe(201);
    expect((await ctx.api.post(`/api/v1/tasks/${c}/dependencies`).set(lead.auth).send({ dependsOnTaskId: b })).status).toBe(201);
    const cycle = await ctx.api.post(`/api/v1/tasks/${a}/dependencies`).set(lead.auth).send({ dependsOnTaskId: c });
    expect(cycle.status).toBe(409);

    // default workflow: todo -> done is not allowed; blocked tasks cannot finish
    expect((await ctx.api.patch(`/api/v1/tasks/${a}/move`).set(lead.auth).send({ status: 'done' })).status).toBe(409);
    expect((await ctx.api.patch(`/api/v1/tasks/${a}/move`).set(lead.auth).send({ status: 'in_progress' })).status).toBe(200);
    await ctx.api.patch(`/api/v1/tasks/${b}/move`).set(lead.auth).send({ status: 'in_progress' });
    const blocked = await ctx.api.patch(`/api/v1/tasks/${b}/move`).set(lead.auth).send({ status: 'done' });
    expect(blocked.status).toBe(409);
    expect((await ctx.api.patch(`/api/v1/tasks/${a}/move`).set(lead.auth).send({ status: 'done' })).status).toBe(200);
    expect((await ctx.api.patch(`/api/v1/tasks/${b}/move`).set(lead.auth).send({ status: 'done' })).status).toBe(200);

    const board = await ctx.api.get(`/api/v1/projects/${pid}/board`).set(lead.auth);
    expect(board.body.data.columns.find((x: { status: string }) => x.status === 'done').tasks).toHaveLength(2);
    const act = await ctx.api.get(`/api/v1/tasks/${a}/activity`).set(lead.auth);
    expect(act.body.data.length).toBeGreaterThanOrEqual(2);

    // viewer-level project member cannot write
    await ctx.api.put(`/api/v1/projects/${pid}/members/${stranger.userId}`).set(lead.auth).send({ role: 'viewer' });
    expect((await ctx.api.get(`/api/v1/projects/${pid}/tasks`).set(stranger.auth)).status).toBe(200);
    expect((await ctx.api.post(`/api/v1/projects/${pid}/tasks`).set(stranger.auth).send({ title: 'nope' })).status).toBe(403);
    const prog = await ctx.api.get(`/api/v1/projects/${pid}/progress`).set(lead.auth);
    expect(prog.body.data.doneTasks).toBe(2);
  });

  it('honours an organization-defined workflow for task transitions', async () => {
    const a = await createActor(ctx);
    const proj = await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `WF ${uniq()}` });
    const t = await ctx.api.post(`/api/v1/projects/${proj.body.data.id}/tasks`).set(a.auth).send({ title: 'wf' });
    const def = await ctx.api.post('/api/v1/workflows').set(a.auth).send({ key: 'task', name: 'Task flow', entityType: 'task' });
    const ver = await ctx.api.post(`/api/v1/workflows/${def.body.data.id}/versions`).set(a.auth).send({
      initialState: 'todo',
      states: [{ key: 'todo', label: 'To do' }, { key: 'done', label: 'Done', final: true }],
      transitions: [{ from: 'todo', to: 'done', action: 'finish' }],
    });
    expect(ver.status).toBe(201);
    await ctx.api.post(`/api/v1/workflows/versions/${ver.body.data.id}/publish`).set(a.auth);
    // todo -> done now allowed directly (was forbidden by the default map)
    const mv = await ctx.api.patch(`/api/v1/tasks/${t.body.data.id}/move`).set(a.auth).send({ status: 'done' });
    expect(mv.status).toBe(200);
  });

  it('materializes recurring tasks idempotently and creates projects from templates', async () => {
    const a = await createActor(ctx);
    const proj = await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `Rec ${uniq()}` });
    const rule = await ctx.api.post(`/api/v1/projects/${proj.body.data.id}/recurring-rules`).set(a.auth)
      .send({ title: 'Weekly report', frequency: 'weekly', nextRunOn: day(today(), -14) });
    expect(rule.status).toBe(201);
    const first = await materializeRecurring(ctx.svc.db, today());
    expect(first).toBeGreaterThanOrEqual(3);
    expect(await materializeRecurring(ctx.svc.db, today())).toBe(0); // idempotent
    const list = await ctx.api.get(`/api/v1/projects/${proj.body.data.id}/tasks`).set(a.auth);
    expect(list.body.data.filter((x: { title: string }) => x.title === 'Weekly report').length).toBeGreaterThanOrEqual(3);

    const tpl = await ctx.api.post('/api/v1/project-templates').set(a.auth).send({ name: `Tpl ${uniq()}` });
    await ctx.api.put(`/api/v1/project-templates/${tpl.body.data.id}/tasks`).set(a.auth).send({ tasks: [{ title: 'Kickoff', offsetDays: 0 }, { title: 'Launch', offsetDays: 14 }] });
    const from = await ctx.api.post('/api/v1/projects/from-template').set(a.auth).set('Idempotency-Key', randomUUID())
      .send({ templateId: tpl.body.data.id, name: `From tpl ${uniq()}`, startDate: today() });
    expect(from.status).toBe(201);
    expect(from.body.data.tasks).toBe(2);
  });
});

describe('timesheets + approvals', () => {
  it('validates entries, prevents self-approval, locks approved sheets and supports corrections', async () => {
    const worker = await addMember(ctx, admin, ROLE.member);
    const team = await ctx.api.post('/api/v1/teams').set(admin.auth).send({ name: `TS ${uniq()}` });
    await ctx.api.post(`/api/v1/teams/${team.body.data.id}/members`).set(admin.auth).send({ userId: worker.userId });
    const proj = await ctx.api.post('/api/v1/projects').set(admin.auth).send({ name: `TSP ${uniq()}` });

    const sheet = await ctx.api.get('/api/v1/timesheets/mine').set(worker.auth).query({ weekStart: monday() });
    expect(sheet.status).toBe(200);
    const sid = sheet.body.data.id;
    const dayStr = monday();
    const e1 = await ctx.api.post(`/api/v1/timesheets/${sid}/entries`).set(worker.auth).send({ projectId: proj.body.data.id, workDate: dayStr, minutes: 240, billable: true, description: 'work' });
    expect(e1.status).toBe(201);
    expect((await ctx.api.post(`/api/v1/timesheets/${sid}/entries`).set(worker.auth).send({ projectId: proj.body.data.id, workDate: dayStr, minutes: 240, billable: true, description: 'work' })).status).toBe(409); // duplicate
    expect((await ctx.api.post(`/api/v1/timesheets/${sid}/entries`).set(worker.auth).send({ workDate: dayStr, minutes: 600, description: 'too much' })).status).toBe(422); // >12h/day
    expect((await ctx.api.post(`/api/v1/timesheets/${sid}/entries`).set(worker.auth).send({ workDate: day(dayStr, 5), minutes: 60 })).status).toBe(422); // weekend
    expect((await ctx.api.post(`/api/v1/timesheets/${sid}/entries`).set(worker.auth).send({ workDate: day(dayStr, 9), minutes: 60 })).status).toBe(422); // outside period

    expect((await ctx.api.post(`/api/v1/timesheets/${sid}/submit`).set(worker.auth)).status).toBe(200);
    expect((await ctx.api.post(`/api/v1/timesheets/${sid}/entries`).set(worker.auth).send({ workDate: day(dayStr, 1), minutes: 30, description: 'late' })).status).toBe(409);
    // members cannot review; the worker cannot approve their own sheet even as a manager
    expect((await ctx.api.post(`/api/v1/timesheets/${sid}/approve`).set(worker.auth).send({})).status).toBe(403);
    const ok = await ctx.api.post(`/api/v1/timesheets/${sid}/approve`).set(admin.auth).send({});
    expect(ok.status).toBe(200);
    expect((await ctx.api.delete(`/api/v1/timesheets/entries/${e1.body.data.id}`).set(worker.auth)).status).toBe(409); // immutable
    const corr = await ctx.api.post(`/api/v1/timesheets/${sid}/corrections`).set(worker.auth).send({ reason: 'wrong project' });
    expect(corr.status).toBe(201);
    expect(corr.body.data.revision).toBe(2);
    expect((await ctx.api.delete(`/api/v1/timesheets/entries/${e1.body.data.id}`).set(worker.auth)).status).toBe(204);
    const trail = await ctx.api.get(`/api/v1/timesheets/${sid}/corrections`).set(worker.auth);
    expect(trail.body.data).toHaveLength(1);
  });

  it('runs sequential multi-step approvals with quorum, no self-approval, no duplicate decisions', async () => {
    const requester = await addMember(ctx, admin, ROLE.member);
    const a1 = await addMember(ctx, admin, ROLE.manager);
    const a2 = await addMember(ctx, admin, ROLE.manager);
    const tpl = await ctx.api.post('/api/v1/approval-templates').set(admin.auth).send({
      key: `expense_${uniq().replace(/-/g, '_')}`, name: 'Expense', subjectType: 'expense',
      steps: [
        { mode: 'any', approvers: [{ type: 'user', id: a1.userId }] },
        { mode: 'quorum', quorum: 2, approvers: [{ type: 'user', id: a2.userId }, { type: 'user', id: admin.userId }, { type: 'user', id: requester.userId }] },
      ],
    });
    expect(tpl.status).toBe(201);
    const req = await ctx.api.post('/api/v1/approvals').set(requester.auth).send({ templateKey: tpl.body.data.key, title: 'Laptop purchase' });
    expect(req.status).toBe(201);
    const rid = req.body.data.id;
    // requester is excluded from approvers; strangers learn nothing
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(requester.auth).send({})).status).toBe(403);
    const stranger = await addMember(ctx, admin, ROLE.manager);
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(stranger.auth).send({})).status).toBe(404);
    expect((await ctx.api.get(`/api/v1/approvals/${rid}`).set(stranger.auth)).status).toBe(404);
    // step 2 approver cannot decide before step 1 completes
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(a2.auth).send({})).status).toBe(404);
    const inbox = await ctx.api.get('/api/v1/approvals/inbox').set(a1.auth);
    expect(inbox.body.data.map((r: { id: string }) => r.id)).toContain(rid);
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(a1.auth).send({ comment: 'ok' })).body.data.status).toBe('pending');
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(a1.auth).send({})).status).toBe(404); // step moved on
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(a2.auth).send({})).body.data.status).toBe('pending'); // 1 of 2
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(a2.auth).send({})).status).toBe(409); // duplicate decision
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/approve`).set(admin.auth).send({})).body.data.status).toBe('approved');
    expect((await ctx.api.post(`/api/v1/approvals/${rid}/reject`).set(admin.auth).send({})).status).toBe(409);
    const detail = await ctx.api.get(`/api/v1/approvals/${rid}`).set(requester.auth);
    expect(detail.body.data.decisions).toHaveLength(3);
  });

  it('timesheet submit routes through the approval engine and applies the decision', async () => {
    const worker = await addMember(ctx, admin, ROLE.member);
    const mgr = await addMember(ctx, admin, ROLE.manager);
    await ctx.api.post('/api/v1/approval-templates').set(admin.auth).send({
      key: 'timesheet', name: 'Timesheet', subjectType: 'timesheet', steps: [{ mode: 'any', approvers: [{ type: 'user', id: mgr.userId }] }],
    }).then((r) => r.status === 201 || r.status === 409);
    const sheet = await ctx.api.get('/api/v1/timesheets/mine').set(worker.auth).query({ weekStart: monday(-1) });
    await ctx.api.post(`/api/v1/timesheets/${sheet.body.data.id}/entries`).set(worker.auth).send({ workDate: monday(-1), minutes: 120, description: 'x' });
    const sub = await ctx.api.post(`/api/v1/timesheets/${sheet.body.data.id}/submit`).set(worker.auth);
    expect(sub.body.data.approvalRequestId).toBeTruthy();
    expect((await ctx.api.post(`/api/v1/timesheets/${sheet.body.data.id}/approve`).set(admin.auth).send({})).status).toBe(409); // decided via request
    await ctx.api.post(`/api/v1/approvals/${sub.body.data.approvalRequestId}/approve`).set(mgr.auth).send({});
    await flush(ctx);
    const after = await ctx.api.get(`/api/v1/timesheets/${sheet.body.data.id}`).set(worker.auth);
    expect(after.body.data.status).toBe('approved');
  });

  it('escalates overdue approvals once', async () => {
    const requester = await addMember(ctx, admin, ROLE.member);
    const mgr = await addMember(ctx, admin, ROLE.manager);
    const tpl = await ctx.api.post('/api/v1/approval-templates').set(admin.auth).send({
      key: `esc_${uniq().replace(/-/g, '_')}`, name: 'Esc', subjectType: 'misc',
      steps: [{ mode: 'any', approvers: [{ type: 'user', id: mgr.userId }], dueHours: 1, escalateTo: admin.userId }],
    });
    const req = await ctx.api.post('/api/v1/approvals').set(requester.auth).send({ templateKey: tpl.body.data.key, title: 'Late one' });
    await withPlatformScope(ctx.svc.db, 'test', (t) => t('approval_steps').where({ request_id: req.body.data.id }).update({ due_at: new Date(Date.now() - 3600_000) }));
    const r1 = await processOverdue(ctx.svc);
    expect(r1.escalated).toBeGreaterThanOrEqual(1);
    const r2 = await processOverdue(ctx.svc);
    expect(r2.escalated).toBe(0);
    const inbox = await ctx.api.get('/api/v1/approvals/inbox').set(admin.auth);
    expect(inbox.body.data.map((r: { id: string }) => r.id)).toContain(req.body.data.id);
  });
});

describe('invoices & payments', () => {
  let customerId: string;
  let taxId: string;
  beforeAll(async () => {
    const cust = await ctx.api.post('/api/v1/billing-customers').set(admin.auth).send({ name: `Cust ${uniq()}`, currency: 'USD' });
    customerId = cust.body.data.id;
    const tax = await ctx.api.post('/api/v1/tax-configurations').set(admin.auth).send({ name: 'VAT', rate: 10 });
    taxId = tax.body.data.id;
  });

  const draft = async (lines: unknown[] = [{ description: 'Consulting', quantity: '10', unitPrice: '100.00', taxIds: [taxId] }]) => {
    const r = await ctx.api.post('/api/v1/invoices').set(admin.auth).set('Idempotency-Key', randomUUID()).send({ customerId, lines });
    expect(r.status).toBe(201);
    return r.body.data as { id: string; total: string; balance: string; status: string };
  };
  const send = async (id: string) => ctx.api.post(`/api/v1/invoices/${id}/send`).set(admin.auth).set('Idempotency-Key', randomUUID());

  it('recomputes totals server-side and ignores client-supplied totals', async () => {
    const r = await ctx.api.post('/api/v1/invoices').set(admin.auth)
      .send({ customerId, total: '1.00', subtotal: '1.00', lines: [{ description: 'x', quantity: '2', unitPrice: '50', taxIds: [taxId] }] });
    expect(r.body.data.subtotal).toBe('100.0000');
    expect(r.body.data.taxTotal).toBe('10.0000');
    expect(r.body.data.total).toBe('110.0000');
  });

  it('assigns gap-free numbers under concurrency and keeps them unique', async () => {
    const ids = await Promise.all([draft(), draft(), draft(), draft(), draft()].map(async (p) => (await p).id));
    const sent = await Promise.all(ids.map((id) => send(id)));
    expect(sent.every((s) => s.status === 200)).toBe(true);
    const nums = sent.map((s) => s.body.data.number as string).sort();
    expect(new Set(nums).size).toBe(5);
    const seq = nums.map((n) => Number(n.split('-').pop()));
    const min = Math.min(...seq);
    expect(seq.sort((a, b) => a - b)).toEqual([min, min + 1, min + 2, min + 3, min + 4]); // no gaps
  });

  it('requires idempotency keys and replays on retry', async () => {
    const d = await draft();
    const noKey = await ctx.api.post(`/api/v1/invoices/${d.id}/send`).set(admin.auth);
    expect(noKey.status).toBe(422);
    const key = randomUUID();
    const a = await ctx.api.post(`/api/v1/invoices/${d.id}/send`).set(admin.auth).set('Idempotency-Key', key);
    const b = await ctx.api.post(`/api/v1/invoices/${d.id}/send`).set(admin.auth).set('Idempotency-Key', key);
    expect(b.body.data.number).toBe(a.body.data.number);
    expect(b.headers['idempotent-replay']).toBe('true');
  });

  it('state machine: payments update status; paid/void invoices are immutable', async () => {
    const d = await draft([{ description: 'Svc', quantity: '1', unitPrice: '200.00' }]);
    const s = await send(d.id);
    expect(s.status).toBe(200);
    const pay1 = await ctx.api.post('/api/v1/payments').set(admin.auth).set('Idempotency-Key', randomUUID())
      .send({ customerId, amount: '50.00', currency: 'USD', allocations: [{ invoiceId: d.id, amount: '50.00' }] });
    expect(pay1.status).toBe(201);
    let inv = await ctx.api.get(`/api/v1/invoices/${d.id}`).set(admin.auth);
    expect(inv.body.data.status).toBe('partially_paid');
    expect(inv.body.data.balance).toBe('150.0000');
    // over-allocation is rejected and nothing is partially applied
    const over = await ctx.api.post('/api/v1/payments').set(admin.auth).set('Idempotency-Key', randomUUID())
      .send({ customerId, amount: '500.00', currency: 'USD', allocations: [{ invoiceId: d.id, amount: '500.00' }] });
    expect(over.status).toBe(422);
    const pay2 = await ctx.api.post('/api/v1/payments').set(admin.auth).set('Idempotency-Key', randomUUID())
      .send({ customerId, amount: '150.00', currency: 'USD', allocations: [{ invoiceId: d.id, amount: '150.00' }] });
    expect(pay2.status).toBe(201);
    inv = await ctx.api.get(`/api/v1/invoices/${d.id}`).set(admin.auth);
    expect(inv.body.data.status).toBe('paid');
    expect((await ctx.api.patch(`/api/v1/invoices/${d.id}`).set(admin.auth).send({ notes: 'x' })).status).toBe(409);
    expect((await ctx.api.post(`/api/v1/invoices/${d.id}/void`).set(admin.auth).send({ reason: 'oops' })).status).toBe(409);
    expect((await ctx.api.delete(`/api/v1/invoices/${d.id}`).set(admin.auth)).status).toBe(409);
    expect(inv.body.data.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['draft', 'sent', 'partially_paid', 'paid']);
    // database-level guard: even a direct total change on a paid invoice is refused
    await expect(withPlatformScope(ctx.svc.db, 'test', (t) => t('invoices').where({ id: d.id }).update({ total: '1.0000' }))).rejects.toThrow(/immutable/);
  });

  it('credit notes reduce the balance; reconcile matches by reference', async () => {
    const d = await draft([{ description: 'Svc', quantity: '1', unitPrice: '100.00' }]);
    const s = await send(d.id);
    const cn = await ctx.api.post(`/api/v1/invoices/${d.id}/credit-notes`).set(admin.auth).set('Idempotency-Key', randomUUID()).send({ amount: '30.00', reason: 'goodwill' });
    expect(cn.status).toBe(201);
    expect(cn.body.data.invoiceBalance).toBe('70.0000');
    const tooMuch = await ctx.api.post(`/api/v1/invoices/${d.id}/credit-notes`).set(admin.auth).set('Idempotency-Key', randomUUID()).send({ amount: '90.00', reason: 'too much' });
    expect(tooMuch.status).toBe(422);
    await ctx.api.post('/api/v1/payments').set(admin.auth).set('Idempotency-Key', randomUUID())
      .send({ customerId, amount: '70.00', currency: 'USD', reference: s.body.data.number });
    const dry = await ctx.api.post('/api/v1/payments/reconcile').set(admin.auth).set('Idempotency-Key', randomUUID()).send({ apply: false });
    expect(dry.body.data.matches.some((m: { invoiceId: string }) => m.invoiceId === d.id)).toBe(true);
    const apply = await ctx.api.post('/api/v1/payments/reconcile').set(admin.auth).set('Idempotency-Key', randomUUID()).send({ apply: true });
    expect(apply.body.data.matches.some((m: { applied: boolean }) => m.applied)).toBe(true);
    expect((await ctx.api.get(`/api/v1/invoices/${d.id}`).set(admin.auth)).body.data.status).toBe('paid');
  });

  it('marks overdue by job, produces receivables aging, PDF, and invoices from approved timesheets', async () => {
    const d = await draft([{ description: 'Late', quantity: '1', unitPrice: '40.00' }]);
    await ctx.api.patch(`/api/v1/invoices/${d.id}`).set(admin.auth).send({ issueDate: day(today(), -100), dueDate: day(today(), -45) });
    await send(d.id);
    expect(await markOverdueInvoices(ctx.svc, today())).toBeGreaterThanOrEqual(1);
    expect(await markOverdueInvoices(ctx.svc, today())).toBe(0);
    const aging = await ctx.api.get('/api/v1/receivables/summary').set(admin.auth);
    expect(Number(aging.body.data.buckets['31-60'])).toBeGreaterThanOrEqual(40);
    const pdf = await ctx.api.get(`/api/v1/invoices/${d.id}/pdf`).set(admin.auth).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (x: Buffer) => chunks.push(x)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const admin2 = await createActor(ctx);
    const cust2 = await ctx.api.post('/api/v1/billing-customers').set(admin2.auth).send({ name: `C2 ${uniq()}`, currency: 'USD' });
    const worker = await addMember(ctx, admin2, ROLE.member);
    const sheet = await ctx.api.get('/api/v1/timesheets/mine').set(worker.auth).query({ weekStart: monday(-2) });
    await ctx.api.post(`/api/v1/timesheets/${sheet.body.data.id}/entries`).set(worker.auth).send({ workDate: monday(-2), minutes: 150, billable: true, description: 'billable' });
    await ctx.api.post(`/api/v1/timesheets/${sheet.body.data.id}/submit`).set(worker.auth);
    await ctx.api.post(`/api/v1/timesheets/${sheet.body.data.id}/approve`).set(admin2.auth).send({});
    const gen = await ctx.api.post('/api/v1/invoices/from-timesheets').set(admin2.auth).set('Idempotency-Key', randomUUID())
      .send({ customerId: cust2.body.data.id, hourlyRate: '80', from: monday(-2), to: day(monday(-2), 6) });
    expect(gen.status).toBe(201);
    expect(gen.body.data.total).toBe('200.0000'); // 2.5h * 80
    const again = await ctx.api.post('/api/v1/invoices/from-timesheets').set(admin2.auth).set('Idempotency-Key', randomUUID())
      .send({ customerId: cust2.body.data.id, hourlyRate: '80', from: monday(-2), to: day(monday(-2), 6) });
    expect(again.status).toBe(409); // already invoiced: no double billing
  });
});

describe('notifications', () => {
  it('delivers in-app + email once per event, honours preferences, and escapes templates', async () => {
    const a = await addMember(ctx, admin, ROLE.manager);
    const proj = await ctx.api.post('/api/v1/projects').set(admin.auth).send({ name: `N ${uniq()}` });
    const mailsTo = () => ctx.mail.outbox.filter((m) => m.to === a.email).length;
    const sent0 = mailsTo();
    await ctx.api.post(`/api/v1/projects/${proj.body.data.id}/tasks`).set(admin.auth).send({ title: '<b>Hi</b> there', assigneeId: a.userId });
    await flush(ctx);
    await flush(ctx);
    const list = await ctx.api.get('/api/v1/notifications').set(a.auth).query({ unread: 'true' });
    expect(list.body.data.length).toBe(1);
    expect(list.body.data[0].type).toBe('task.assigned');
    expect(mailsTo()).toBe(sent0 + 1);
    await flush(ctx);
    expect((await ctx.api.get('/api/v1/notifications').set(a.auth)).body.data.length).toBe(1); // no duplicates
    expect((await ctx.api.post(`/api/v1/notifications/${list.body.data[0].id}/read`).set(a.auth)).status).toBe(200);
    expect((await ctx.api.get('/api/v1/notifications/unread-count').set(a.auth)).body.data.unread).toBe(0);

    await ctx.api.put('/api/v1/notification-preferences').set(a.auth).send({ preferences: [{ eventType: 'task.assigned', channel: 'email', enabled: false }] });
    const before = mailsTo();
    await ctx.api.post(`/api/v1/projects/${proj.body.data.id}/tasks`).set(admin.auth).send({ title: 'Second', assigneeId: a.userId });
    await flush(ctx);
    expect(mailsTo()).toBe(before);
    const prev = await ctx.api.post('/api/v1/notification-templates/preview').set(admin.auth).send({ subject: 'Hi {{name}}', body: '{{name}}', sample: { name: '<script>x</script>' } });
    expect(prev.body.data.html).toBe('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('module flags', () => {
  it('hides a module (404) when its flag is off for the organization and shows module_not_enabled in the dashboard', async () => {
    const a = await createActor(ctx);
    const { newId } = await import('../src/platform/crypto.js');
    await withPlatformScope(ctx.svc.db, 'test', (t) => t('feature_flag_overrides').insert({ id: newId(), flag_key: 'module.projects', target_org_id: a.organizationId, enabled: false }));
    expect((await ctx.api.get('/api/v1/projects').set(a.auth)).status).toBe(404);
    const dash = await ctx.api.get('/api/v1/dashboard').set(a.auth);
    const w = dash.body.data.widgets.find((x: { key: string }) => x.key === 'tasks.my_open');
    expect(w.state).toBe('module_not_enabled');
    const flags = await ctx.api.get('/api/v1/feature-flags/evaluate').set(a.auth);
    expect(flags.body.data['module.projects']).toBe(false);
    void loginActor;
  });
});
