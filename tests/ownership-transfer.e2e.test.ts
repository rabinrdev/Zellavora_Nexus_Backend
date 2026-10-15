import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCtx, createActor, loginActor, STRONG_PASSWORD, type TestCtx } from './helpers/app.js';
import { addMember, ROLE } from './helpers/members.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await getCtx();
});
afterAll(async () => {
  await ctx.close();
});

describe('pending ownership transfer is discoverable by both sides', () => {
  it('shows an outgoing offer to the owner and an incoming one to the recipient', async () => {
    const owner = await createActor(ctx);
    const heir = await addMember(ctx, owner, ROLE.manager);

    expect((await ctx.api.get('/api/v1/organization/transfer-ownership').set(owner.auth)).body.data).toEqual([]);

    const started = await ctx.api
      .post('/api/v1/organization/transfer-ownership')
      .set(owner.auth)
      .send({ newOwnerUserId: heir.userId, password: STRONG_PASSWORD });
    expect(started.status).toBe(201);

    const mine = await ctx.api.get('/api/v1/organization/transfer-ownership').set(owner.auth);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ id: started.body.data.id, direction: 'outgoing', toUserId: heir.userId });

    const heirAuth = await loginActor(ctx, heir.email);
    const theirs = await ctx.api.get('/api/v1/organization/transfer-ownership').set(heirAuth.auth);
    expect(theirs.body.data).toHaveLength(1);
    expect(theirs.body.data[0]).toMatchObject({ id: started.body.data.id, direction: 'incoming' });

    const accepted = await ctx.api
      .post(`/api/v1/organization/transfer-ownership/${started.body.data.id}/accept`)
      .set(heirAuth.auth);
    expect(accepted.status).toBe(200);
    // Ownership changed their permissions, so the old token is rejected; sign in again.
    const heirAgain = await loginActor(ctx, heir.email);
    expect((await ctx.api.get('/api/v1/organization/transfer-ownership').set(heirAgain.auth)).body.data).toEqual([]);
  });

  it('hides the offer from members who are not part of it', async () => {
    const owner = await createActor(ctx);
    const heir = await addMember(ctx, owner, ROLE.manager);
    const bystander = await addMember(ctx, owner);
    await ctx.api
      .post('/api/v1/organization/transfer-ownership')
      .set(owner.auth)
      .send({ newOwnerUserId: heir.userId, password: STRONG_PASSWORD });
    const bystanderAuth = await loginActor(ctx, bystander.email);
    expect((await ctx.api.get('/api/v1/organization/transfer-ownership').set(bystanderAuth.auth)).body.data).toEqual([]);
  });
});
