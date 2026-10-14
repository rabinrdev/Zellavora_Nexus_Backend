import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { isFlagEnabled } from '../../platform/flags.js';
import type { Trx } from '../../platform/scope.js';

const obj = z.record(z.string(), z.unknown());

interface Source {
  type: string;
  permission: string;
  flag?: string;
  run(trx: Trx, orgId: string, like: string, limit: number): Promise<{ id: string; title: string; subtitle?: string | null }[]>;
}

const esc = (s: string) => s.replace(/[%_\\]/g, '\\$&');

/** Each source declares the permission and module flag required, so search can never widen access. */
const SOURCES: Source[] = [
  { type: 'project', permission: 'projects:read', flag: 'module.projects',
    run: (t, o, l, n) => t('projects').where({ organization_id: o }).whereNull('deleted_at').whereILike('name', l).limit(n).select('id', 'name as title', 'status as subtitle') },
  { type: 'task', permission: 'tasks:read', flag: 'module.projects',
    run: (t, o, l, n) => t('tasks').where({ organization_id: o }).whereNull('deleted_at').whereILike('title', l).limit(n).select('id', 'title', 'status as subtitle') },
  { type: 'document', permission: 'documents:read', flag: 'module.documents',
    run: (t, o, l, n) => t('documents').where({ organization_id: o }).whereNull('deleted_at').whereILike('title', l).limit(n).select('id', 'title') },
  { type: 'client', permission: 'customers:read', flag: 'module.invoices',
    run: (t, o, l, n) => t('billing_customers').where({ organization_id: o }).whereNull('deleted_at').whereILike('name', l).limit(n).select('id', 'name as title', 'email as subtitle') },
  { type: 'lead', permission: 'leads:read', flag: 'module.crm',
    run: (t, o, l, n) => t('leads').where({ organization_id: o }).whereNull('deleted_at').whereILike('name', l).limit(n).select('id', 'name as title', 'company as subtitle') },
  { type: 'contact', permission: 'contacts:read', flag: 'module.crm',
    run: (t, o, l, n) => t('contacts').where({ organization_id: o }).whereNull('deleted_at').whereILike('name', l).limit(n).select('id', 'name as title', 'email as subtitle') },
  { type: 'member', permission: 'users:read',
    run: (t, o, l, n) => t('organization_memberships as m').join('users as u', 'u.id', 'm.user_id').where('m.organization_id', o).whereNot('m.status', 'removed')
      .where((w) => w.whereILike('u.name', l).orWhereILike('u.email', l)).limit(n).select('u.id', 'u.name as title', 'u.email as subtitle') },
];

defineRoute({
  method: 'get', path: '/search', module: 'search', summary: 'Global search across modules the caller may access',
  access: 'authenticated', rateLimit: 'search',
  query: z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(20).default(5), types: z.string().max(200).optional() }),
  response: obj,
  async handler(c) {
    const like = `%${esc(c.query.q)}%`;
    const wanted = c.query.types ? new Set(c.query.types.split(',')) : null;
    const results: Record<string, unknown[]> = {};
    for (const s of SOURCES) {
      if (wanted && !wanted.has(s.type)) continue;
      if (!c.auth!.permissions.has(s.permission)) continue;
      if (s.flag && !(await isFlagEnabled(c.trx, s.flag, { organizationId: c.orgId(), userId: c.auth!.userId }))) continue;
      const rows = await s.run(c.trx, c.orgId(), like, c.query.limit);
      if (rows.length) results[s.type] = rows;
    }
    return { status: 200, data: { query: c.query.q, results } };
  },
});
