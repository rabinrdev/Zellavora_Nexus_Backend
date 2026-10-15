import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCtx, createActor, uniq, type Actor, type TestCtx } from './helpers/app.js';

let ctx: TestCtx;
let admin: Actor;
beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('project template tasks can be read back', () => {
  it('returns the tasks in the order they were saved', async () => {
    const tpl = await ctx.api.post('/api/v1/project-templates').set(admin.auth).send({ name: `Template ${uniq()}` });
    expect(tpl.status).toBe(201);
    const id = tpl.body.data.id as string;

    expect((await ctx.api.get(`/api/v1/project-templates/${id}/tasks`).set(admin.auth)).body.data).toEqual([]);

    const saved = await ctx.api
      .put(`/api/v1/project-templates/${id}/tasks`)
      .set(admin.auth)
      .send({
        tasks: [
          { title: 'Kick-off', priority: 'high', offsetDays: 0, estimateHours: 2 },
          { title: 'Review', offsetDays: 7 },
        ],
      });
    expect(saved.status).toBe(200);

    const list = await ctx.api.get(`/api/v1/project-templates/${id}/tasks`).set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: { title: string }) => t.title)).toEqual(['Kick-off', 'Review']);
    expect(list.body.data[0]).toMatchObject({ priority: 'high', offsetDays: 0, estimateHours: 2 });
    expect(list.body.data[1]).toMatchObject({ priority: 'medium', offsetDays: 7, estimateHours: null });
  });

  it('answers 404 for a missing template', async () => {
    const res = await ctx.api.get('/api/v1/project-templates/00000000-0000-7000-8000-00000000dead/tasks').set(admin.auth);
    expect(res.status).toBe(404);
  });
});
