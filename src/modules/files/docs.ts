import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';

const file = z.object({
  id: uuid.describe('File id.'), filename: z.string().describe('Original file name.'),
  contentType: z.string().describe('Detected MIME type (sniffed from content, not trusted from the client).'),
  size: z.number().int().describe('Size in bytes.'), sha256: z.string().describe('SHA-256 of the content (hex).'),
  scanStatus: z.enum(['pending', 'clean', 'infected', 'failed']).describe('Malware scan result. Only `clean` files can be downloaded.'),
  purpose: z.string().describe('What the file was uploaded for, e.g. `general`, `export`, `import`.'),
  ownerId: uuid.nullable().describe('User that uploaded the file.'), createdAt: isoDate.describe('Upload time.'),
  previewable: z.boolean().describe('`true` when the file is clean and an inline preview is supported (images, PDF).'),
});

documentRoutes({
  uploadFile: {
    response: file, responseName: 'FileObject', successStatus: 201, errors: [422],
    description: 'Uploads one file as `multipart/form-data` (field `file`, optional text field `purpose`). Size is limited by `MAX_UPLOAD_BYTES` and the organization storage quota; executable and mismatching content types are rejected with `422`. The file is virus-scanned before it can be downloaded.',
  },
  listFiles: {
    response: file, responseName: 'FileObject',
    list: { sortable: ['created_at', 'size', 'filename'], filterable: ['purpose', 'scan_status'], defaultSort: '-created_at', searchable: false },
    description: 'Lists non-deleted files of the organization.',
  },
  getFileUsage: {
    response: z.object({
      usedBytes: z.number().int().describe('Bytes currently stored.'), quotaBytes: z.number().int().describe('Storage quota of the organization.'),
      remainingBytes: z.number().int().describe('Remaining bytes (never negative).'),
    }),
    description: 'Current storage consumption against the quota.',
  },
  downloadFileBySignedLink: {
    errors: [409],
    description: 'Public download using a signed link from `getFileDownloadLink` or `getExportById`. Links expire after 5 minutes; an invalid or expired link returns `404`. The response body is the file with `Content-Disposition: attachment`.',
  },
  getFileById: { response: file, responseName: 'FileObject', description: 'File metadata (the content is not included).' },
  getFileDownloadLink: {
    response: z.object({
      url: z.string().describe('Relative URL of the signed download (`/api/v1/files/download/{token}`); no Authorization header needed.'),
      expiresAt: isoDate.describe('Expiry (5 minutes).'),
    }),
    errors: [409], description: 'Issues a short-lived signed link. Files that are not `clean` return `409` (scan pending/infected).',
  },
  downloadFile: { errors: [409], description: 'Streams the file through the API (requires the bearer token). Files that are not `clean` return `409`.' },
  deleteFile: { successStatus: 204, description: 'Soft-deletes the file, releases its storage quota and removes the stored object.' },
});
