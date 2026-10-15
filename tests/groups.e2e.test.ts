import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCtx, createActor, uniq, type Actor, type TestCtx } from './helpers/app.js';
import { addMember, ROLE } from './helpers/members.js';

let ctx: TestCtx;
let admin: Actor;
beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('group members and roles can be read back', () => {
  it('lists the members and roles of a group', async () => {
    const group = await ctx.api.post('/api/v1/groups').set(admin.auth).send({ name: `Group ${uniq()}` });
    expect(group.status).toBe(201);
    const id = group.body.data.id as string;
    const member = await addMember(ctx, admin);

    expect((await ctx.api.get(`/api/v1/groups/${id}/members`).set(admin.auth)).body.data).toEqual([]);
    const add = await ctx.api.post(`/api/v1/groups/${id}/members`).set(admin.auth).send({ userId: member.userId });
    expect(add.status).toBe(201);

    const members = await ctx.api.get(`/api/v1/groups/${id}/members`).set(admin.auth);
    expect(members.status).toBe(200);
    expect(members.body.data).toHaveLength(1);
    expect(members.body.data[0]).toMatchObject({ userId: member.userId, email: member.email });

    const set = await ctx.api.put(`/api/v1/groups/${id}/roles`).set(admin.auth).send({ roleIds: [ROLE.viewer] });
    expect(set.status).toBe(200);
    const roles = await ctx.api.get(`/api/v1/groups/${id}/roles`).set(admin.auth);
    expect(roles.body.data.map((r: { id: string }) => r.id)).toEqual([ROLE.viewer]);
  });

  it('answers 404 for a group of another organization', async () => {
    const other = await createActor(ctx);
    const group = await ctx.api.post('/api/v1/groups').set(other.auth).send({ name: `Other ${uniq()}` });
    const res = await ctx.api.get(`/api/v1/groups/${group.body.data.id}/members`).set(admin.auth);
    expect(res.status).toBe(404);
  });
});
