import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { rowToApi, mapDbError } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { cleanHtml } from '../cms/routes.js';

const M = 'support';
const FLAG = 'module.support';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();

const article = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), title: z.string().trim().min(2).max(200),
  body: z.string().min(1).max(100_000), category: z.string().max(60).default('general'), locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en'),
});

// articles visible to a tenant: global (organization_id NULL) + their own, published only
defineRoute({
  method: 'get', path: '/help/articles', module: M, moduleFlag: FLAG, summary: 'Search help articles (global + organization)',
  access: { permission: 'help:read' }, query: listQuerySchema.extend({ category: z.string().max(60).optional(), locale: z.string().max(10).default('en') }), response: obj,
  async handler(c) {
    const q = c.query as { category?: string; locale: string } & ListQuery;
    const qb = c.trx('help_articles').where({ status: 'published', locale: q.locale })
      .where((w) => w.whereNull('organization_id').orWhere({ organization_id: c.orgId() }))
      .select('id', 'slug', 'title', 'category', 'locale', 'organization_id', 'updated_at');
    if (q.category) qb.where({ category: q.category });
    if (q.q) qb.where((w) => w.whereILike('title', `%${q.q!.replace(/[%_\\]/g, '\\$&')}%`).orWhereILike('body', `%${q.q!.replace(/[%_\\]/g, '\\$&')}%`));
    const page = await paginate(qb, q, { sortable: { title: 'title', updated_at: 'updated_at' }, defaultSort: 'title' });
    return { data: page.data.map((r) => ({ ...rowToApi(r, ['organization_id']), scope: r.organization_id ? 'organization' : 'global' })), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/help/articles/by-slug/:slug', module: M, moduleFlag: FLAG, summary: 'Read a help article',
  access: { permission: 'help:read' }, params: z.object({ slug: z.string().max(100) }), query: z.object({ locale: z.string().max(10).default('en') }), response: obj,
  async handler(c) {
    const a = await c.trx('help_articles').where({ slug: c.params.slug, locale: c.query.locale, status: 'published' })
      .where((w) => w.whereNull('organization_id').orWhere({ organization_id: c.orgId() })).orderByRaw('organization_id IS NULL').first(); // org override wins
    if (!a) throw new AppError('NOT_FOUND', 'Article not found');
    return { data: rowToApi(a, ['organization_id']) };
  },
});

defineRoute({
  method: 'post', path: '/help/articles/:id/feedback', module: M, moduleFlag: FLAG, summary: 'Was this helpful?',
  access: { permission: 'help:read' }, params: z.object({ id: uuid }), body: z.object({ helpful: z.boolean(), comment: z.string().max(1000).optional() }), response: obj,
  async handler(c) {
    const a = await c.trx('help_articles').where({ id: c.params.id, status: 'published' }).where((w) => w.whereNull('organization_id').orWhere({ organization_id: c.orgId() })).first();
    if (!a) throw new AppError('NOT_FOUND', 'Article not found');
    await c.trx('help_feedback').insert({ id: newId(), organization_id: c.orgId(), article_id: a.id, user_id: c.auth!.userId, helpful: c.body.helpful, comment: c.body.comment ?? null })
      .onConflict(['article_id', 'user_id']).merge({ helpful: c.body.helpful, comment: c.body.comment ?? null });
    return { status: 200, data: { recorded: true } };
  },
});

defineRoute({
  method: 'post', path: '/help/articles', module: M, moduleFlag: FLAG, summary: 'Create an organization help article',
  access: { permission: 'help:manage' }, body: article.extend({ status: z.enum(['draft', 'published']).default('draft') }), response: obj,
  audit: { action: 'help_article.created', resourceType: 'help_article' },
  async handler(c) {
    const id = newId();
    try {
      await c.trx('help_articles').insert({ id, organization_id: c.orgId(), ...c.body, body: cleanHtml(c.body.body), updated_by: c.auth!.userId });
    } catch (e) { throw mapDbError(e); }
    return { status: 201, data: { id, slug: c.body.slug } };
  },
});

defineRoute({
  method: 'patch', path: '/help/articles/:id', module: M, moduleFlag: FLAG, summary: 'Update an organization help article',
  access: { permission: 'help:manage' }, params: z.object({ id: uuid }),
  body: article.partial().extend({ status: z.enum(['draft', 'published']).optional() }), response: obj,
  audit: { action: 'help_article.updated', resourceType: 'help_article' },
  async handler(c) {
    if (Object.keys(c.body).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update');
    const patch: Record<string, unknown> = { ...c.body, updated_at: c.svc.now(), updated_by: c.auth!.userId };
    if (c.body.body !== undefined) patch.body = cleanHtml(c.body.body);
    try {
      const n = await c.trx('help_articles').where({ id: c.params.id, organization_id: c.orgId() }).update(patch);
      if (!n) throw new AppError('NOT_FOUND', 'Article not found'); // global articles are immutable to tenants
    } catch (e) { throw mapDbError(e); }
    return { status: 200, data: { id: c.params.id } };
  },
});

defineRoute({
  method: 'put', path: '/platform/help/articles/:slug', module: M, summary: 'Create or update a global help article (platform admin)',
  access: 'platformAdmin', params: z.object({ slug: z.string().max(100) }),
  body: article.omit({ slug: true }).extend({ status: z.enum(['draft', 'published']).default('published') }), response: obj,
  async handler(c) {
    const existing = await c.trx('help_articles').whereNull('organization_id').where({ slug: c.params.slug, locale: c.body.locale }).first();
    const row = { ...c.body, body: cleanHtml(c.body.body), updated_at: c.svc.now(), updated_by: c.auth!.userId };
    if (existing) await c.trx('help_articles').where({ id: existing.id }).update(row);
    else await c.trx('help_articles').insert({ id: newId(), organization_id: null, slug: c.params.slug, ...row });
    return { status: 200, data: { slug: c.params.slug, locale: c.body.locale } };
  },
});

// product adoption: a checklist computed from real state (no fake progress)
defineRoute({
  method: 'get', path: '/onboarding/checklist', module: M, moduleFlag: FLAG, summary: 'Getting-started checklist derived from real data',
  access: { permission: 'help:read' }, response: obj,
  async handler(c) {
    const cnt = async (t: string, extra: Record<string, unknown> = {}) =>
      Number(((await c.trx(t).where({ organization_id: c.orgId(), ...extra }).count({ c: '*' }).first()) as { c: string }).c);
    const org = await c.trx('organizations').where({ id: c.orgId() }).first();
    const members = await cnt('organization_memberships', { status: 'active' });
    const items = [
      { key: 'profile', title: 'Complete the organization profile', done: !!org.logo_file_id || Object.keys(org.branding ?? {}).length > 0 },
      { key: 'invite', title: 'Invite your first teammate', done: members > 1 || (await cnt('invitations')) > 0 },
      { key: 'department', title: 'Create a department', done: (await cnt('departments')) > 0 },
      { key: 'security', title: 'Review the security policy', done: (await cnt('security_policies')) > 0 },
      { key: 'project', title: 'Create your first project', done: (await c.trx.schema.hasTable('projects')) && (await cnt('projects')) > 0 },
    ];
    return { data: { items, completed: items.filter((i) => i.done).length, total: items.length } };
  },
});

defineRoute({
  method: 'get', path: '/help/feedback-summary', module: M, moduleFlag: FLAG, summary: 'Article feedback summary', access: { permission: 'help:manage' }, response: obj,
  async handler(c) {
    const rows = (await c.trx('help_feedback as f').join('help_articles as a', 'a.id', 'f.article_id').where('f.organization_id', c.orgId())
      .groupBy('a.id', 'a.title').select('a.id', 'a.title').count({ total: '*' })
      .select(c.trx.raw('count(*) FILTER (WHERE f.helpful)::int AS helpful'))) as unknown as { id: string; title: string; total: string; helpful: number }[];
    return { data: rows.map((r) => ({ articleId: r.id, title: r.title, total: Number(r.total), helpful: Number(r.helpful) })) };
  },
});
