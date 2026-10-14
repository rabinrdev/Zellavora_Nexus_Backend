import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const current = z.object({
  version: z.number().int().describe('Version number.'), fileId: uuid.describe('File of this version.'), filename: z.string().describe('File name.'),
  contentType: z.string().describe('MIME type.'), size: z.number().int().describe('Bytes.'), scanStatus: z.string().describe('Malware scan status.'),
});
const doc = rowOf('documents', { describe: { title: 'Document title.', currentVersion: 'Latest version number.', expiresAt: 'Date the document expires (reminders are sent).' } })
  .extend({ current: current.nullable().describe('Current version summary.') });
const docDetail = doc.extend({
  metadata: z.array(z.object({ key: z.string().describe('Metadata key.'), type: z.string().describe('Value type.'), value: z.unknown().describe('Typed value.') })).describe('Typed metadata.'),
  versions: z.array(rowOf('document_versions')).describe('All versions.'),
});

documentRoutes({
  uploadDocument: {
    successStatus: 201, response: doc, responseName: 'Document', errors: [402],
    description: 'Creates a document with its first version from `multipart/form-data` (`file`, `title`, optional `description`, `categoryId`, `expiresAt`). The creator gets `manage` access; the file is scanned before download. Counts against the storage quota.',
  },
  uploadDocumentVersion: {
    successStatus: 201, response: z.object({ id: uuid.describe('Document id.'), version: z.number().int().describe('New version number.') }),
    description: 'Uploads a new version (`multipart/form-data`: `file`, optional `note`). Older versions stay downloadable.',
  },
  listDocuments: {
    response: doc, responseName: 'Document', list: { sortable: ['created_at', 'title'], filterable: [], defaultSort: '-created_at' },
    description: 'Searches documents the caller may see (via ACL, role or ownership). Extra filters are documented in the query parameters.',
  },
  getDocumentQuota: { response: z.object({ usedBytes: z.number().int().describe('Bytes used.'), quotaBytes: z.number().int().describe('Quota.'), percentUsed: z.number().describe('Percent of quota used (1 decimal).') }), description: 'Storage quota status for documents.' },
  getDocumentById: { response: docDetail, responseName: 'DocumentDetail', description: 'Document with current version, metadata and all versions. Without access the document looks absent (`404`).' },
  updateDocument: { successStatus: 200, response: doc, responseName: 'Document', description: 'Updates title, description, category or expiry. Requires `edit` access.' },
  deleteDocument: { successStatus: 204, description: 'Soft-deletes the document; restore with `restoreDocument`.' },
  restoreDocument: { successStatus: 200, response: z.object({ id: uuid.describe('Document id.'), restored: z.literal(true).describe('Always true.') }), description: 'Restores a soft-deleted document.' },
  replaceDocumentMetadata: { successStatus: 200, response: z.object({ id: uuid.describe('Document id.'), items: z.number().int().describe('Metadata items stored.') }), description: 'Replaces typed metadata (max 50 items).' },
  getDocumentAcl: {
    response: z.object({
      id: uuid.describe('Entry id.'), documentId: uuid.describe('Document.'), principalType: z.enum(['user', 'role', 'group']).describe('Who the entry applies to.'),
      principalId: uuid.describe('User, role or group id.'), permission: z.enum(['view', 'edit', 'manage']).describe('Granted level.'),
    }).loose(),
    responseName: 'DocumentAclEntry', collection: true, description: 'Access list of the document.',
  },
  replaceDocumentAcl: { successStatus: 200, response: z.object({ id: uuid.describe('Document id.'), entries: z.number().int().describe('Entries stored.') }), description: 'Replaces the access list (max 100 entries). Requires `manage` access.' },
  getDocumentDownloadLink: {
    successStatus: 200, errors: [409],
    response: z.object({ url: z.string().describe('Signed relative download URL.'), expiresAt: isoDate.describe('Expiry (5 minutes).'), file: z.object({ id: uuid.describe('File id.'), filename: z.string().describe('File name.'), contentType: z.string().describe('MIME type.'), size: z.number().int().describe('Bytes.') }).loose().describe('File metadata.') }),
    description: 'Issues a signed link to the current (or `version`) file; the download is audited. Files not yet scanned clean return `409`.',
  },
});
