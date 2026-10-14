import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { hmac, newId, safeEqual } from '../../platform/crypto.js';
import { crudResource, rowToApi, mapDbError } from '../../platform/crud.js';
import { slugify } from '../organizations/provision.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { isFlagEnabled } from '../../platform/flags.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import type { Services } from '../../platform/types.js';

const M = 'cms';
const FLAG = 'module.cms';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

/** Server-side rich-text sanitation: a strict allow-list; scripts, handlers and unsafe URLs never survive. */
export const cleanHtml = (html: string) => sanitizeHtml(html, {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'a', 'img', 'code', 'pre', 'hr', 'span'],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height'], '*': [] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
});

const seoSchema = z.object({
  title: z.string().max(120).optional(), description: z.string().max(320).optional(),
  ogImageFileId: uuid.optional(), noindex: z.boolean().optional(),
}).default({});

const itemBody = z.object({
  title: z.string().trim().min(1).max(200), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).optional(),
  excerpt: z.string().max(500).default(''), body: z.string().max(200_000).default(''), categoryId: uuid.nullable().optional(),
  seo: seoSchema, layoutKey: z.string().max(60).nullable().optional(),
});

const snapshot = (i: Record<string, unknown>) => ({
  title: i.title, slug: i.slug, excerpt: i.excerpt, body: i.body, categoryId: i.category_id, seo: i.seo, layoutKey: i.layout_key,
});

async function saveVersion(trx: Trx, orgId: string, item: Record<string, unknown>, actor: string | null, note?: string) {
  await trx('content_versions').insert({
    id: newId(), organization_id: orgId, item_id: item.id, version: item.current_version, snapshot: JSON.stringify(snapshot(item)), note: note ?? null, created_by: actor,
  });
}

async function loadItem(c: HandlerCtx, id: string, type: 'page' | 'post') {
  const it = await c.trx('content_items').where({ id, organization_id: c.orgId(), type }).whereNull('deleted_at').first();
  if (!it) throw new AppError('NOT_FOUND', `${type === 'page' ? 'Page' : 'Post'} not found`);
  return it;
}

crudResource({
  module: M, moduleFlag: FLAG, path: '/content-categories', table: 'content_categories', resource: 'content_categories', softDelete: true,
  create: z.object({ name: z.string().trim().min(1).max(100), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100) }),
  list: { sortable: { name: 'content_categories.name' }, defaultSort: 'name' },
});

const TYPES = [
  { type: 'page' as const, path: '/pages', res: 'pages' },
  { type: 'post' as const, path: '/posts', res: 'posts' },
];

for (const T of TYPES) {
  defineRoute({
    method: 'post', path: T.path, module: M, moduleFlag: FLAG, summary: `Create a ${T.type} (draft)`,
    access: { permission: `${T.res}:create` }, body: itemBody, response: obj, audit: { action: `${T.type}.created`, resourceType: T.type },
    async handler(c) {
      const id = newId();
      const slug = c.body.slug ?? slugify(c.body.title);
      try {
        await c.trx('content_items').insert({
          id, organization_id: c.orgId(), type: T.type, slug, title: c.body.title, excerpt: c.body.excerpt, body: cleanHtml(c.body.body),
          category_id: c.body.categoryId ?? null, seo: JSON.stringify(c.body.seo), layout_key: c.body.layoutKey ?? null,
          author_id: c.auth!.userId, created_by: c.auth!.userId, updated_by: c.auth!.userId,
        });
      } catch (e) { throw mapDbError(e); }
      const item = await c.trx('content_items').where({ id }).first();
      await saveVersion(c.trx, c.orgId(), item, c.auth!.userId, 'created');
      return { status: 201, data: rowToApi(item) };
    },
  });

  defineRoute({
    method: 'get', path: T.path, module: M, moduleFlag: FLAG, summary: `List ${T.res}`,
    access: { permission: `${T.res}:read` }, query: listQuerySchema, response: obj,
    async handler(c) {
      const qb = c.trx('content_items').where({ organization_id: c.orgId(), type: T.type }).whereNull('deleted_at')
        .select('id', 'slug', 'title', 'excerpt', 'status', 'category_id', 'publish_at', 'published_at', 'current_version', 'published_version', 'created_at', 'updated_at');
      const q = c.query as ListQuery;
      if (q.q) qb.whereILike('title', `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      const page = await paginate(qb, q, { sortable: { title: 'title', created_at: 'created_at', published_at: 'published_at' }, filterable: { status: 'status', category_id: 'category_id' }, defaultSort: '-created_at' });
      return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
    },
  });

  defineRoute({
    method: 'get', path: `${T.path}/:id`, module: M, moduleFlag: FLAG, summary: `Get a ${T.type} (working copy)`,
    access: { permission: `${T.res}:read` }, params: idParams, response: obj,
    async handler(c) { return { data: rowToApi(await loadItem(c, c.params.id, T.type)) }; },
  });

  defineRoute({
    method: 'patch', path: `${T.path}/:id`, module: M, moduleFlag: FLAG, summary: `Edit a ${T.type} (creates a new version; publish to go live)`,
    access: { permission: `${T.res}:update` }, params: idParams,
    body: itemBody.partial().extend({ rowVersion: z.number().int().optional() }), response: obj, audit: { action: `${T.type}.updated`, resourceType: T.type },
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      const { rowVersion, ...b } = c.body;
      if (rowVersion !== undefined && rowVersion !== it.row_version) throw new AppError('PRECONDITION_FAILED', 'Modified by someone else; reload and retry');
      if (Object.keys(b).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update');
      const patch: Record<string, unknown> = {
        updated_at: c.svc.now(), updated_by: c.auth!.userId, current_version: it.current_version + 1, row_version: c.trx.raw('row_version + 1'),
      };
      if (b.title !== undefined) patch.title = b.title;
      if (b.slug !== undefined) patch.slug = b.slug;
      if (b.excerpt !== undefined) patch.excerpt = b.excerpt;
      if (b.body !== undefined) patch.body = cleanHtml(b.body);
      if (b.categoryId !== undefined) patch.category_id = b.categoryId;
      if (b.seo !== undefined) patch.seo = JSON.stringify(b.seo);
      if (b.layoutKey !== undefined) patch.layout_key = b.layoutKey;
      try { await c.trx('content_items').where({ id: it.id }).update(patch); } catch (e) { throw mapDbError(e); }
      const updated = await c.trx('content_items').where({ id: it.id }).first();
      await saveVersion(c.trx, c.orgId(), updated, c.auth!.userId);
      return { status: 200, data: rowToApi(updated) };
    },
  });

  defineRoute({
    method: 'delete', path: `${T.path}/:id`, module: M, moduleFlag: FLAG, summary: `Delete a ${T.type} (soft)`,
    access: { permission: `${T.res}:delete` }, params: idParams, audit: { action: `${T.type}.deleted`, resourceType: T.type },
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      await c.trx('content_items').where({ id: it.id }).update({ deleted_at: c.svc.now(), deleted_by: c.auth!.userId, status: 'unpublished' });
      return { status: 204, auditResourceId: it.id };
    },
  });

  // publishing requires its own permission, separate from editing (F-224)
  defineRoute({
    method: 'post', path: `${T.path}/:id/publish`, module: M, moduleFlag: FLAG, summary: `Publish the current version of a ${T.type}`,
    access: { permission: `${T.res}:publish` }, params: idParams, response: obj, audit: { action: `${T.type}.published`, resourceType: T.type },
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      await publishItem(c.trx, c.orgId(), it, c.auth!.userId, c.svc.now());
      return { status: 200, data: { id: it.id, status: 'published', publishedVersion: it.current_version } };
    },
  });

  defineRoute({
    method: 'post', path: `${T.path}/:id/schedule`, module: M, moduleFlag: FLAG, summary: `Schedule publication of a ${T.type}`,
    access: { permission: `${T.res}:publish` }, params: idParams, body: z.object({ publishAt: z.string().datetime() }), response: obj,
    audit: { action: `${T.type}.scheduled`, resourceType: T.type },
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      if (new Date(c.body.publishAt) <= c.svc.now()) throw new AppError('VALIDATION_FAILED', 'publishAt must be in the future', [{ field: 'publishAt', issue: 'past' }]);
      await c.trx('content_items').where({ id: it.id }).update({ status: 'scheduled', publish_at: c.body.publishAt, updated_at: c.svc.now() });
      return { status: 200, data: { id: it.id, status: 'scheduled', publishAt: c.body.publishAt } };
    },
  });

  defineRoute({
    method: 'post', path: `${T.path}/:id/unpublish`, module: M, moduleFlag: FLAG, summary: `Unpublish a ${T.type}`,
    access: { permission: `${T.res}:publish` }, params: idParams, response: obj, audit: { action: `${T.type}.unpublished`, resourceType: T.type },
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      await c.trx('content_items').where({ id: it.id }).update({ status: 'unpublished', publish_at: null, updated_at: c.svc.now() });
      return { status: 200, data: { id: it.id, status: 'unpublished' } };
    },
  });

  defineRoute({
    method: 'get', path: `${T.path}/:id/versions`, module: M, moduleFlag: FLAG, summary: 'Version history',
    access: { permission: `${T.res}:read` }, params: idParams, response: obj,
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      const rows = await c.trx('content_versions').where({ item_id: it.id }).orderBy('version', 'desc').select('version', 'note', 'created_by', 'created_at');
      return { data: rows.map((r) => ({ ...rowToApi(r), published: r.version === it.published_version })) };
    },
  });

  defineRoute({
    method: 'post', path: `${T.path}/:id/versions/:version/rollback`, module: M, moduleFlag: FLAG, summary: 'Roll back by creating a new version from an old one',
    access: { permission: `${T.res}:update` }, params: z.object({ id: uuid, version: z.coerce.number().int().min(1) }), response: obj,
    audit: { action: `${T.type}.rolled_back`, resourceType: T.type },
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      const old = await c.trx('content_versions').where({ item_id: it.id, version: c.params.version }).first();
      if (!old) throw new AppError('NOT_FOUND', 'Version not found');
      const s = old.snapshot as ReturnType<typeof snapshot>;
      await c.trx('content_items').where({ id: it.id }).update({
        title: s.title, slug: s.slug, excerpt: s.excerpt, body: s.body, category_id: s.categoryId ?? null, seo: JSON.stringify(s.seo ?? {}),
        layout_key: s.layoutKey ?? null, current_version: it.current_version + 1, updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1'),
      });
      const updated = await c.trx('content_items').where({ id: it.id }).first();
      await saveVersion(c.trx, c.orgId(), updated, c.auth!.userId, `rollback to v${c.params.version}`); // history is never rewritten
      return { status: 201, data: { id: it.id, version: updated.current_version, restoredFrom: c.params.version } };
    },
  });

  defineRoute({
    method: 'get', path: `${T.path}/:id/seo-preview`, module: M, moduleFlag: FLAG, summary: 'SEO preview with warnings',
    access: { permission: `${T.res}:read` }, params: idParams, response: obj,
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      const seo = it.seo as { title?: string; description?: string; noindex?: boolean };
      const title = (seo.title || it.title) as string;
      const description = (seo.description || it.excerpt || '') as string;
      const warnings: string[] = [];
      if (title.length > 60) warnings.push('Title is longer than 60 characters and may be truncated');
      if (description.length === 0) warnings.push('Missing meta description');
      if (description.length > 160) warnings.push('Description is longer than 160 characters and may be truncated');
      const org = await c.trx('organizations').where({ id: c.orgId() }).first();
      return { data: { title: title.slice(0, 60), description: description.slice(0, 160), path: `/${org.slug}/${T.res}/${it.slug}`, noindex: !!seo.noindex, warnings } };
    },
  });

  defineRoute({
    method: 'post', path: `${T.path}/:id/preview-link`, module: M, moduleFlag: FLAG, summary: 'Signed, expiring preview link for a draft',
    access: { permission: `${T.res}:read` }, params: idParams, response: obj,
    async handler(c) {
      const it = await loadItem(c, c.params.id, T.type);
      const exp = Math.floor(c.svc.now().getTime() / 1000) + 3600;
      const payload = `${it.id}.${c.orgId()}.${exp}`;
      const token = `${Buffer.from(payload).toString('base64url')}.${hmac(`${c.svc.env.JWT_SECRET}:preview`, payload)}`;
      return { status: 200, data: { url: `/api/v1/public/preview/${token}`, expiresAt: new Date(exp * 1000).toISOString() } };
    },
  });
}

async function publishItem(trx: Trx, orgId: string, it: Record<string, unknown>, actor: string | null, now: Date) {
  await trx('content_items').where({ id: it.id }).update({
    status: 'published', published_version: it.current_version, published_at: now, publish_at: null, updated_at: now,
  });
  if (it.type === 'page') {
    const blocks = await trx('content_blocks').where({ item_id: it.id }).orderBy('position').select('type', 'props');
    await trx('publish_versions').insert({
      id: newId(), organization_id: orgId, item_id: it.id, version: it.current_version, blocks: JSON.stringify(blocks), published_by: actor,
    }).onConflict(['item_id', 'version']).merge({ blocks: JSON.stringify(blocks), published_at: now });
  }
}

/** Scheduled publishing (job): idempotent — only moves items still in `scheduled` whose time has come. */
export async function publishDueContent(svc: Services): Promise<number> {
  const due = await withPlatformScope(svc.db, 'cms-schedule', (t) => t('content_items').where({ status: 'scheduled' }).where('publish_at', '<=', svc.now()).whereNull('deleted_at'));
  for (const it of due) {
    await withTenant(svc.db, { organizationId: it.organization_id, userId: null }, (trx) => publishItem(trx, it.organization_id, it, null, svc.now()));
  }
  return due.length;
}
jobRegistrars.push((svc) => { svc.jobs.work('reminders', async () => { await publishDueContent(svc); }); });

// ---- media library -----------------------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/media', module: M, moduleFlag: FLAG, summary: 'Register an uploaded image in the media library',
  access: { permission: 'media:create' }, body: z.object({ fileId: uuid, altText: z.string().max(200).default(''), title: z.string().max(200).default('') }), response: obj,
  async handler(c) {
    const f = await c.trx('files').where({ id: c.body.fileId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!f || !String(f.content_type).startsWith('image/')) throw new AppError('VALIDATION_FAILED', 'File must be an uploaded image', [{ field: 'fileId', issue: 'not_image' }]);
    const id = newId();
    try {
      await c.trx('media_assets').insert({ id, organization_id: c.orgId(), file_id: f.id, alt_text: c.body.altText, title: c.body.title, created_by: c.auth!.userId, updated_by: c.auth!.userId });
    } catch (e) { throw mapDbError(e); }
    return { status: 201, data: { id, fileId: f.id } };
  },
});

defineRoute({
  method: 'get', path: '/media', module: M, moduleFlag: FLAG, summary: 'Media library', access: { permission: 'media:read' }, response: obj,
  async handler(c) {
    const rows = await c.trx('media_assets as m').join('files as f', 'f.id', 'm.file_id').where('m.organization_id', c.orgId()).whereNull('f.deleted_at')
      .orderBy('m.created_at', 'desc').select('m.id', 'm.alt_text', 'm.title', 'f.id as file_id', 'f.original_filename', 'f.content_type', 'f.scan_status');
    return { data: rows.map((r) => rowToApi(r)) };
  },
});

// ---- page builder (F-118..F-121, F-221) ----------------------------------------------------------------------------------

const url = z.string().max(500).refine((u) => /^(https:\/\/|\/|mailto:)/.test(u), 'must be https, relative or mailto');
export const BLOCKS = {
  hero: z.object({ heading: z.string().max(160), subheading: z.string().max(300).optional(), imageFileId: uuid.optional(), ctaLabel: z.string().max(40).optional(), ctaUrl: url.optional() }),
  text: z.object({ html: z.string().max(50_000) }),
  image: z.object({ fileId: uuid, alt: z.string().max(200), caption: z.string().max(300).optional() }),
  gallery: z.object({ fileIds: z.array(uuid).min(1).max(24) }),
  cta: z.object({ label: z.string().max(60), url, style: z.enum(['primary', 'secondary']).default('primary') }),
  columns: z.object({ columns: z.array(z.object({ html: z.string().max(20_000) })).min(1).max(4) }),
} as const;
type BlockType = keyof typeof BLOCKS;

const blockInput = z.object({ type: z.enum(Object.keys(BLOCKS) as [BlockType, ...BlockType[]]), props: z.record(z.string(), z.unknown()) });

function validateBlock(b: z.infer<typeof blockInput>, idx: number) {
  const r = BLOCKS[b.type].safeParse(b.props);
  if (!r.success) throw new AppError('VALIDATION_FAILED', 'Invalid block', r.error.issues.map((i) => ({ field: `blocks.${idx}.props.${i.path.join('.')}`, issue: i.message })));
  const props = { ...(r.data as Record<string, unknown>) };
  if (typeof props.html === 'string') props.html = cleanHtml(props.html);
  if (Array.isArray(props.columns)) props.columns = (props.columns as { html: string }[]).map((c) => ({ html: cleanHtml(c.html) }));
  return props;
}

defineRoute({
  method: 'get', path: '/pages/:id/blocks', module: 'pagebuilder', moduleFlag: 'module.pagebuilder', summary: 'Blocks of a page draft',
  access: { permission: 'pages:read' }, params: idParams, response: obj,
  async handler(c) {
    const it = await loadItem(c, c.params.id, 'page');
    return { data: (await c.trx('content_blocks').where({ item_id: it.id }).orderBy('position')).map((b) => ({ id: b.id, type: b.type, props: b.props, position: b.position })) };
  },
});

defineRoute({
  method: 'put', path: '/pages/:id/blocks', module: 'pagebuilder', moduleFlag: 'module.pagebuilder', summary: 'Replace the blocks of a page draft',
  access: { permission: 'pages:update' }, params: idParams, body: z.object({ blocks: z.array(blockInput).max(100) }), response: obj,
  audit: { action: 'page.blocks_changed', resourceType: 'page' },
  async handler(c) {
    const it = await loadItem(c, c.params.id, 'page');
    const cleaned = c.body.blocks.map((b, i) => ({ type: b.type, props: validateBlock(b, i) }));
    await c.trx('content_blocks').where({ item_id: it.id }).delete();
    if (cleaned.length) {
      await c.trx('content_blocks').insert(cleaned.map((b, i) => ({
        id: newId(), organization_id: c.orgId(), item_id: it.id, type: b.type, props: JSON.stringify(b.props), position: i, created_by: c.auth!.userId, updated_by: c.auth!.userId,
      })));
    }
    await c.trx('content_items').where({ id: it.id }).update({ current_version: it.current_version + 1, updated_at: c.svc.now(), updated_by: c.auth!.userId });
    const updated = await c.trx('content_items').where({ id: it.id }).first();
    await saveVersion(c.trx, c.orgId(), updated, c.auth!.userId, 'blocks changed');
    return { status: 200, data: { id: it.id, blocks: cleaned.length, version: updated.current_version } };
  },
});

defineRoute({
  method: 'put', path: '/pages/:id/blocks/order', module: 'pagebuilder', moduleFlag: 'module.pagebuilder', summary: 'Persist drag-and-drop ordering',
  access: { permission: 'pages:update' }, params: idParams, body: z.object({ ids: z.array(uuid).min(1).max(100) }), response: obj,
  async handler(c) {
    const it = await loadItem(c, c.params.id, 'page');
    const existing = await c.trx('content_blocks').where({ item_id: it.id }).select('id');
    const set = new Set(existing.map((e) => e.id as string));
    if (c.body.ids.length !== set.size || c.body.ids.some((i) => !set.has(i)) || new Set(c.body.ids).size !== set.size) {
      throw new AppError('VALIDATION_FAILED', 'ids must be exactly the blocks of this page', [{ field: 'ids', issue: 'mismatch' }]);
    }
    for (const [i, id] of c.body.ids.entries()) await c.trx('content_blocks').where({ id }).update({ position: i });
    return { status: 200, data: { id: it.id, order: c.body.ids } };
  },
});

defineRoute({
  method: 'get', path: '/layout-presets', module: 'pagebuilder', moduleFlag: 'module.pagebuilder', summary: 'Layout presets (system + organization)',
  access: { permission: 'pages:read' }, response: obj,
  async handler(c) {
    const rows = await c.trx('layout_presets').where((w) => w.whereNull('organization_id').orWhere({ organization_id: c.orgId() })).orderBy('name');
    const builtin = [
      { key: 'landing', name: 'Landing page', blocks: [{ type: 'hero', props: { heading: 'Welcome' } }, { type: 'text', props: { html: '<p>Introduce your product.</p>' } }, { type: 'cta', props: { label: 'Get started', url: '/signup', style: 'primary' } }] },
      { key: 'article', name: 'Article', blocks: [{ type: 'text', props: { html: '<p>Write your article.</p>' } }] },
    ];
    return { data: [...builtin.map((b) => ({ ...b, system: true })), ...rows.map((r) => ({ key: r.key, name: r.name, blocks: r.blocks, system: r.organization_id === null }))] };
  },
});

// ---- themes (F-123..F-125) ----------------------------------------------------------------------------------------------

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const FONTS = ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Merriweather', 'Playfair Display', 'system-ui', 'Georgia'] as const;
const tokens = z.object({
  colors: z.object({ primary: hex, secondary: hex, background: hex, surface: hex, text: hex, accent: hex.optional() }),
  typography: z.object({ headingFont: z.enum(FONTS), bodyFont: z.enum(FONTS), baseSize: z.number().int().min(12).max(22) }),
  radius: z.number().int().min(0).max(32).default(8),
  spacing: z.number().int().min(2).max(16).default(4),
});

crudResource({
  module: 'themes', moduleFlag: 'module.themes', path: '/themes', table: 'themes', resource: 'themes', rowVersion: true,
  create: z.object({ name: z.string().trim().min(2).max(80), tokens }),
  list: { sortable: { name: 'themes.name', created_at: 'themes.created_at' }, defaultSort: 'name' },
  actions: ['list', 'get', 'create', 'update', 'delete'],
  hooks: {
    async beforeDelete(_c, _trx, existing) {
      if (existing.is_active) throw new AppError('CONFLICT', 'The active theme cannot be deleted');
    },
  },
});

defineRoute({
  method: 'post', path: '/themes/:id/activate', module: 'themes', moduleFlag: 'module.themes', summary: 'Make a theme the single active theme',
  access: { permission: 'themes:publish' }, params: idParams, response: obj, audit: { action: 'theme.activated', resourceType: 'theme' },
  async handler(c) {
    const t = await c.trx('themes').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!t) throw new AppError('NOT_FOUND', 'Theme not found');
    await c.trx('themes').where({ organization_id: c.orgId(), is_active: true }).update({ is_active: false });
    await c.trx('themes').where({ id: t.id }).update({ is_active: true, updated_at: c.svc.now() });
    return { status: 200, data: { id: t.id, active: true } };
  },
});

defineRoute({
  method: 'put', path: '/brand-assets/:kind', module: 'themes', moduleFlag: 'module.themes', summary: 'Set a brand asset (logo/favicon/banner)',
  access: { permission: 'themes:update' }, params: z.object({ kind: z.enum(['logo', 'favicon', 'banner']) }), body: z.object({ fileId: uuid }), response: obj,
  audit: { action: 'brand_asset.changed', resourceType: 'brand_asset' },
  async handler(c) {
    const f = await c.trx('files').where({ id: c.body.fileId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!f || !String(f.content_type).startsWith('image/')) throw new AppError('VALIDATION_FAILED', 'File must be an uploaded image', [{ field: 'fileId', issue: 'not_image' }]);
    await c.trx('brand_assets').insert({ id: newId(), organization_id: c.orgId(), kind: c.params.kind, file_id: f.id, created_by: c.auth!.userId, updated_by: c.auth!.userId })
      .onConflict(['organization_id', 'kind']).merge({ file_id: f.id, updated_at: c.svc.now() });
    return { status: 200, data: { kind: c.params.kind, fileId: f.id } };
  },
});

// ---- public read endpoints: published content only --------------------------------------------------------------------------

async function publicOrg(c: HandlerCtx, slug: string, flag: string) {
  const org = await c.trx('organizations').where({ slug, status: 'active' }).first();
  if (!org || !(await isFlagEnabled(c.trx, flag, { organizationId: org.id }))) throw new AppError('NOT_FOUND', 'Resource not found');
  return org;
}

async function publicItems(c: HandlerCtx, orgId: string, type: 'page' | 'post', slug?: string) {
  const q = c.trx('content_items as i').join('content_versions as v', function () { this.on('v.item_id', 'i.id').andOn('v.version', 'i.published_version'); })
    .where({ 'i.organization_id': orgId, 'i.type': type, 'i.status': 'published' }).whereNull('i.deleted_at')
    .select('i.id', 'i.slug', 'i.published_at', 'v.snapshot', 'i.type');
  if (slug) q.where('i.slug', slug);
  return q.orderBy('i.published_at', 'desc').limit(100);
}

const pubDto = (r: { id: string; slug: string; published_at: Date; snapshot: Record<string, unknown> }) => ({
  id: r.id, slug: r.slug, title: r.snapshot.title, excerpt: r.snapshot.excerpt, body: r.snapshot.body, seo: r.snapshot.seo, publishedAt: new Date(r.published_at).toISOString(),
});

for (const T of TYPES) {
  defineRoute({
    method: 'get', path: `/public/:orgSlug/${T.res}`, module: 'public', summary: `Published ${T.res}`, access: 'public', rateLimit: 'search',
    params: z.object({ orgSlug: z.string().max(60) }), response: obj,
    async handler(c) {
      const org = await publicOrg(c, c.params.orgSlug, FLAG);
      return { status: 200, data: (await publicItems(c, org.id, T.type)).map(pubDto) };
    },
  });
  defineRoute({
    method: 'get', path: `/public/:orgSlug/${T.res}/:slug`, module: 'public', summary: `A published ${T.type} by slug`, access: 'public', rateLimit: 'search',
    params: z.object({ orgSlug: z.string().max(60), slug: z.string().max(100) }), response: obj,
    async handler(c) {
      const org = await publicOrg(c, c.params.orgSlug, FLAG);
      const [row] = await publicItems(c, org.id, T.type, c.params.slug);
      if (!row) throw new AppError('NOT_FOUND', 'Resource not found'); // drafts are indistinguishable from missing
      let blocks: unknown = undefined;
      if (T.type === 'page') {
        const pv = await c.trx('publish_versions').where({ item_id: row.id }).orderBy('version', 'desc').first();
        blocks = pv?.blocks ?? [];
      }
      return { status: 200, data: { ...pubDto(row), ...(blocks !== undefined ? { blocks } : {}) } };
    },
  });
}

defineRoute({
  method: 'get', path: '/public/:orgSlug/theme', module: 'public', summary: 'Active theme tokens', access: 'public', rateLimit: 'search',
  params: z.object({ orgSlug: z.string().max(60) }), response: obj,
  async handler(c) {
    const org = await publicOrg(c, c.params.orgSlug, 'module.themes');
    const t = await c.trx('themes').where({ organization_id: org.id, is_active: true }).first();
    if (!t) throw new AppError('NOT_FOUND', 'Resource not found');
    return { status: 200, data: { name: t.name, tokens: t.tokens } };
  },
});

defineRoute({
  method: 'get', path: '/public/preview/:token', module: 'public', summary: 'Preview a draft via signed link', access: 'public', rateLimit: 'search',
  params: z.object({ token: z.string().min(20).max(1024) }), response: obj,
  async handler(c) {
    const [p, sig] = c.params.token.split('.');
    let payload = '';
    try { payload = Buffer.from(p ?? '', 'base64url').toString('utf8'); } catch { /* invalid */ }
    const [itemId, orgId, exp] = payload.split('.');
    if (!sig || !itemId || !orgId || !safeEqual(hmac(`${c.svc.env.JWT_SECRET}:preview`, payload), sig) || Number(exp) < Math.floor(Date.now() / 1000)) {
      throw new AppError('NOT_FOUND', 'Link is invalid or has expired');
    }
    return withTenant(c.svc.db, { organizationId: orgId, userId: null }, async (trx) => {
      const it = await trx('content_items').where({ id: itemId, organization_id: orgId }).whereNull('deleted_at').first();
      if (!it) throw new AppError('NOT_FOUND', 'Link is invalid or has expired');
      const blocks = it.type === 'page' ? await trx('content_blocks').where({ item_id: it.id }).orderBy('position').select('type', 'props') : undefined;
      return { status: 200, data: { ...rowToApi(it), preview: true, ...(blocks ? { blocks } : {}) } };
    });
  },
});
