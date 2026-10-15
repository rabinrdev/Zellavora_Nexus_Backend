import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCtx, createActor, type Actor, type TestCtx } from './helpers/app.js';
import { addMember } from './helpers/members.js';

let ctx: TestCtx;
let admin: Actor;
beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('approval delegations can be listed and revoked', () => {
  it('lists my active delegations and drops a revoked one', async () => {
    const delegate = await addMember(ctx, admin);
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

    expect((await ctx.api.get('/api/v1/approvals/delegations').set(admin.auth)).body.data).toEqual([]);

    const created = await ctx.api.post('/api/v1/approvals/delegations').set(admin.auth).send({ delegateId: delegate.userId, startsAt, endsAt });
    expect(created.status).toBe(201);

    const list = await ctx.api.get('/api/v1/approvals/delegations').set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: created.body.data.id, delegateId: delegate.userId });
    expect(typeof list.body.data[0].delegateName).toBe('string');

    expect((await ctx.api.delete(`/api/v1/approvals/delegations/${created.body.data.id}`).set(admin.auth)).status).toBe(204);
    expect((await ctx.api.get('/api/v1/approvals/delegations').set(admin.auth)).body.data).toEqual([]);
  });

  it('shows nobody else delegations', async () => {
    const other = await createActor(ctx);
    expect((await ctx.api.get('/api/v1/approvals/delegations').set(other.auth)).body.data).toEqual([]);
  });
});
