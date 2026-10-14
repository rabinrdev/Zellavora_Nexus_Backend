import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const content = rowOf('content_items', {
  describe: {
    type: '`page` or `post`.', slug: 'URL slug, unique per type.', status: '`draft`, `scheduled`, `published` or `unpublished`.',
    currentVersion: 'Working-copy version.', publishedVersion: 'Version that is live; `null` when not published.', publishedAt: 'When it went live.',
  },
});
const version = rowOf('content_versions').extend({ published: z.boolean().describe('`true` for the version that is live.') });
const state = (status: string) => z.object({ id: uuid.describe('Content id.'), status: z.literal(status).describe('New status.') });
const seo = z.object({
  title: z.string().describe('Title as search engines will show it (cut at 60 characters).'), description: z.string().describe('Meta description (cut at 160 characters).'),
  path: z.string().describe('Public path.'), noindex: z.boolean().describe('Whether search engines are told not to index.'),
  warnings: z.array(z.string()).describe('Problems found, e.g. missing description.'),
});
const previewLink = z.object({ url: z.string().describe('Relative URL of the public preview (`getPublicPreviewByToken`).'), expiresAt: isoDate.describe('Link expiry.') });
const blockOut = z.object({ id: uuid.describe('Block id.'), type: z.string().describe('Block type (e.g. `hero`, `text`, `cta`).'), props: z.record(z.string(), z.unknown()).describe('Block properties; the allowed keys depend on `type` and are validated on save.'), position: z.number().int().describe('Order on the page.') });
const pub = z.object({
  id: uuid.describe('Content id.'), slug: z.string().describe('Slug.'), title: z.unknown().describe('Title.'), excerpt: z.unknown().describe('Excerpt.'),
  body: z.unknown().describe('Body (sanitized HTML).'), seo: z.unknown().describe('SEO fields.'), publishedAt: isoDate.describe('Publication time.'),
});

const forType = (t: 'Page' | 'Post') => ({
  [`create${t}`]: { successStatus: 201, response: content, responseName: 'ContentItem', description: `Creates a ${t.toLowerCase()} as a draft (version 1).` },
  [`list${t}s`]: { response: content, responseName: 'ContentItem', list: { sortable: ['created_at', 'title'], filterable: [], defaultSort: '-created_at' }, description: `Lists ${t.toLowerCase()}s of the organization.` },
  [`get${t}ById`]: { response: content, responseName: 'ContentItem', description: `The working copy of a ${t.toLowerCase()}.` },
  [`update${t}`]: { successStatus: 200, response: content, responseName: 'ContentItem', errors: [409, 412], description: 'Saves changes as a **new version**; nothing goes live until `publish`.' },
  [`delete${t}`]: { successStatus: 204, description: 'Soft-deletes the item.' },
  [`publish${t}`]: { successStatus: 200, response: z.object({ id: uuid.describe('Content id.'), status: z.literal('published').describe('New status.'), publishedVersion: z.number().int().describe('Version now live.') }), description: 'Publishes the current version; it becomes visible through the public delivery endpoints.' },
  [`schedule${t}`]: { successStatus: 200, response: z.object({ id: uuid.describe('Content id.'), status: z.literal('scheduled').describe('New status.'), publishAt: isoDate.describe('Scheduled publication time.') }), description: 'Publishes automatically at `publishAt` (must be in the future).' },
  [`unpublish${t}`]: { successStatus: 200, response: state('unpublished'), description: 'Takes the item offline.' },
  [`list${t}Versions`]: { response: version, responseName: 'ContentVersion', collection: true, description: 'Version history, newest first.' },
  [`rollback${t}Version`]: { successStatus: 201, response: z.object({ id: uuid.describe('Content id.'), version: z.number().int().describe('New version number.'), restoredFrom: z.string().describe('Version that was copied.') }), description: 'Creates a new version from an old one. History is never rewritten.' },
  [`get${t}SeoPreview`]: { response: seo, responseName: 'SeoPreview', description: 'How the item will look in search results, with warnings.' },
  [`create${t}PreviewLink`]: { successStatus: 200, response: previewLink, responseName: 'PreviewLink', description: 'Signed, expiring link that shows the draft without signing in.' },
});

documentRoutes({
  ...forType('Page'),
  ...forType('Post'),
  createMediaAsset: {
    successStatus: 201, response: z.object({ id: uuid.describe('Media asset id.'), fileId: uuid.describe('Underlying file.') }),
    description: 'Registers an already uploaded **image** (`uploadFile`) in the media library with alt text and title.',
  },
  listMediaAssets: {
    response: z.object({
      id: uuid.describe('Asset id.'), altText: z.string().nullable().describe('Alternative text for accessibility.'), title: z.string().nullable().describe('Title.'),
      fileId: uuid.describe('File id.'), originalFilename: z.string().describe('File name.'), contentType: z.string().describe('MIME type.'), scanStatus: z.string().describe('Scan status.'),
    }),
    responseName: 'MediaAsset', collection: true, description: 'Media library, newest first.',
  },
  listPageBlocks: { response: blockOut, responseName: 'PageBlock', collection: true, description: 'Blocks of the page draft in order.' },
  replacePageBlocks: {
    successStatus: 200, response: z.object({ id: uuid.describe('Page id.'), blocks: z.number().int().describe('Blocks stored.'), version: z.number().int().describe('Version created.') }),
    description: 'Replaces all blocks (saved as a new version). Every block is validated against its type; URLs must be https, relative or mailto and HTML is sanitized.',
  },
  reorderPageBlocks: { successStatus: 200, response: z.object({ id: uuid.describe('Page id.'), order: z.array(uuid).describe('Block ids in the new order.') }), description: 'Persists a drag-and-drop order; `ids` must be exactly the current blocks.' },
  listLayoutPresets: {
    response: z.object({ key: z.string().describe('Preset key.'), name: z.string().describe('Preset name.'), blocks: z.array(z.record(z.string(), z.unknown())).describe('Blocks `{ type, props }` the preset creates.'), system: z.boolean().describe('`true` for built-in presets.') }),
    responseName: 'LayoutPreset', collection: true, description: 'Built-in and organization layout presets.',
  },
  activateTheme: { successStatus: 200, response: z.object({ id: uuid.describe('Theme id.'), active: z.literal(true).describe('Always true.') }), description: 'Makes this the single active theme (the previous one is deactivated).' },
  replaceBrandAsset: {
    successStatus: 200, response: z.object({ kind: z.string().describe('`logo`, `favicon` or `banner`.'), fileId: uuid.describe('Uploaded image.') }),
    description: 'Sets a brand asset to an uploaded image.',
  },
  listPublicPages: { collection: true, response: pub, responseName: 'PublicContent', description: 'Published pages of the organization with slug `orgSlug` (max 100). No authentication; rate limited.' },
  getPublicPageBySlug: { response: pub.extend({ blocks: z.array(z.record(z.string(), z.unknown())).optional().describe('Page-builder blocks, when the page has any.') }), responseName: 'PublicContentDetail', description: 'One published page. Drafts and unknown slugs return `404`.' },
  listPublicPosts: { collection: true, response: pub, responseName: 'PublicContent', description: 'Published posts (max 100).' },
  getPublicPostBySlug: { response: pub.extend({ blocks: z.array(z.record(z.string(), z.unknown())).optional().describe('Blocks, when present.') }), responseName: 'PublicContentDetail', description: 'One published post.' },
  getPublicTheme: { response: z.object({ name: z.string().describe('Theme name.'), tokens: z.record(z.string(), z.unknown()).describe('Design tokens: colors, fonts and spacing.') }), responseName: 'PublicTheme', description: 'Tokens of the active theme.' },
  getPublicPreviewByToken: { response: content.extend({ preview: z.literal(true).describe('Marks a draft preview.'), blocks: z.array(z.record(z.string(), z.unknown())).optional().describe('Blocks.') }), responseName: 'PublicPreview', description: 'Draft preview via a signed link from `create…PreviewLink`; expired or invalid links return `404`.' },
});
