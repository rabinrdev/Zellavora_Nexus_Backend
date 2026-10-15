import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCtx, createActor, uniq, type Actor, type TestCtx } from './helpers/app.js';
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

describe('trash listing (deleted=only)', () => {
  it('lists soft-deleted rows for a caller who may delete, and restore brings them back', async () => {
    const created = await ctx.api.post('/api/v1/departments').set(admin.auth).send({ name: `Trash ${uniq()}` });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await ctx.api.delete(`/api/v1/departments/${id}`).set(admin.auth)).status).toBe(204);

    const active = await ctx.api.get('/api/v1/departments').set(admin.auth);
    expect(active.body.data.some((d: { id: string }) => d.id === id)).toBe(false);

    const trash = await ctx.api.get('/api/v1/departments?deleted=only').set(admin.auth);
    expect(trash.status).toBe(200);
    expect(trash.body.data.map((d: { id: string }) => d.id)).toContain(id);
    expect(trash.body.data.every((d: { deletedAt: string | null }) => d.deletedAt !== null)).toBe(true);

    expect((await ctx.api.post(`/api/v1/departments/${id}/restore`).set(admin.auth)).status).toBe(200);
    const after = await ctx.api.get('/api/v1/departments?deleted=only').set(admin.auth);
    expect(after.body.data.map((d: { id: string }) => d.id)).not.toContain(id);
  });

  it('refuses the trash to a caller without the delete permission', async () => {
    const viewer = await addMember(ctx, admin);
    const res = await ctx.api.get('/api/v1/departments?deleted=only').set(viewer.auth);
    expect(res.status).toBe(403);
  });
});
