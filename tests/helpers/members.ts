import { STRONG_PASSWORD, tokenFromMail, uniq, loginActor, type Actor, type TestCtx } from './app.js';

export async function flush(ctx: TestCtx): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if ((await ctx.svc.events.dispatchPending()) === 0) break;
  }
}

/** Invites a new person into the admin's organization with the given role, accepts, and logs in. */
export async function addMember(ctx: TestCtx, admin: Actor, roleId?: string): Promise<Actor> {
  const email = `${uniq('m')}@example.test`;
  const inv = await ctx.api.post('/api/v1/invitations').set(admin.auth).send({ email, ...(roleId ? { roleId } : {}) });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await ctx.api.post('/api/v1/auth/invitations/accept').send({
    token: tokenFromMail(ctx.mail, email), name: 'Member Person', password: STRONG_PASSWORD,
  });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  return loginActor(ctx, email);
}

export const ROLE = {
  org_admin: '00000000-0000-7000-8000-000000000001',
  manager: '00000000-0000-7000-8000-000000000002',
  member: '00000000-0000-7000-8000-000000000003',
  viewer: '00000000-0000-7000-8000-000000000004',
};

/** A role with no permissions at all (used to prove deny-by-default on every route). */
export async function createEmptyRole(ctx: TestCtx, admin: Actor): Promise<string> {
  const r = await ctx.api.post('/api/v1/roles').set(admin.auth).send({ key: `none_${uniq('r').replace(/-/g, '_')}`, name: 'No access', permissions: [] });
  if (r.status !== 201) throw new Error(`role failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.id;
}
