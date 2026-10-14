import { fileTypeFromBuffer } from 'file-type';
import { createConnection } from 'node:net';
import { extname } from 'node:path';
import { AppError } from './errors.js';
import { hmac, newId, randomToken, safeEqual, sha256 } from './crypto.js';
import type { Services } from './types.js';
import type { Trx } from './scope.js';
import { withPlatformScope } from './scope.js';
import { jobRegistrars } from './job-handlers.js';
import { isFlagEnabled } from './flags.js';
import { loadPlanState } from './entitlements.js';

/** Extension -> acceptable detected MIME types (magic-byte sniff). Text types have no magic bytes. */
export const ALLOWED_TYPES: Record<string, string[]> = {
  '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.gif': ['image/gif'], '.webp': ['image/webp'],
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
  '.csv': ['text/csv'], '.txt': ['text/plain'], '.json': ['application/json'], '.zip': ['application/zip'],
};
const TEXT_EXT = new Set(['.csv', '.txt', '.json']);
export const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

export interface ScanProvider {
  scan(data: Buffer): Promise<'clean' | 'infected' | 'failed'>;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Dev/test scanner: flags the EICAR test string; everything else is clean. */
export class StubScanner implements ScanProvider {
  async scan(data: Buffer) {
    return data.includes(Buffer.from(EICAR)) ? ('infected' as const) : ('clean' as const);
  }
}

/** ClamAV via clamd INSTREAM over TCP. Any error resolves to 'failed' (callers fail closed). */
export class ClamdScanner implements ScanProvider {
  constructor(private readonly host: string, private readonly port = 3310) {}
  scan(data: Buffer): Promise<'clean' | 'infected' | 'failed'> {
    return new Promise((resolve) => {
      const sock = createConnection({ host: this.host, port: this.port });
      let out = '';
      sock.setTimeout(30_000, () => { sock.destroy(); resolve('failed'); });
      sock.on('error', () => resolve('failed'));
      sock.on('data', (d) => (out += d.toString()));
      sock.on('close', () => resolve(out.includes('FOUND') ? 'infected' : out.includes('OK') ? 'clean' : 'failed'));
      sock.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += 8192) {
        const chunk = data.subarray(i, i + 8192);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(Buffer.concat([len, chunk]));
      }
      sock.write(Buffer.alloc(4));
    });
  }
}

let scanner: ScanProvider = new StubScanner();
export const setScanner = (s: ScanProvider) => { scanner = s; };

export interface SaveFileInput {
  organizationId: string;
  ownerId: string;
  filename: string;
  declaredType?: string;
  data: Buffer;
  purpose?: string;
  maxBytes?: number;
  allowExtensions?: string[];
}

export async function quotaFor(svc: Services, trx: Trx, organizationId: string): Promise<number> {
  const row = await trx('organization_settings').where({ organization_id: organizationId, key: 'storage.quota_bytes' }).first();
  if (typeof row?.value === 'number') return row.value;
  if (await isFlagEnabled(trx, 'module.billing', { organizationId })) {
    const plan = await loadPlanState(trx, organizationId);
    const lim = plan.metered ? plan.entitlements.get('storage_bytes')?.limit : null;
    if (lim) return lim;
  }
  return svc.env.STORAGE_QUOTA_BYTES;
}

/** Validates (size, extension, declared vs sniffed MIME, quota), stores privately, records metadata, queues a scan. */
export async function saveFile(svc: Services, trx: Trx, input: SaveFileInput): Promise<Record<string, unknown>> {
  const max = input.maxBytes ?? svc.env.MAX_UPLOAD_BYTES;
  if (input.data.length === 0) throw new AppError('VALIDATION_FAILED', 'File is empty', [{ field: 'file', issue: 'empty' }]);
  if (input.data.length > max) throw new AppError('VALIDATION_FAILED', 'File is too large', [{ field: 'file', issue: `max ${max} bytes` }]);
  const ext = extname(input.filename).toLowerCase();
  const allowed = input.allowExtensions ?? Object.keys(ALLOWED_TYPES);
  if (!ext || !allowed.includes(ext) || !ALLOWED_TYPES[ext]) {
    throw new AppError('VALIDATION_FAILED', 'File type is not allowed', [{ field: 'file', issue: `extension ${ext || '(none)'} not allowed` }]);
  }
  let contentType: string;
  if (TEXT_EXT.has(ext)) {
    if (input.data.includes(0)) throw new AppError('VALIDATION_FAILED', 'File content does not match its type', [{ field: 'file', issue: 'binary content in text file' }]);
    contentType = ALLOWED_TYPES[ext]![0]!;
  } else {
    const sniff = await fileTypeFromBuffer(input.data);
    if (!sniff || !ALLOWED_TYPES[ext]!.includes(sniff.mime)) {
      throw new AppError('VALIDATION_FAILED', 'File content does not match its extension', [{ field: 'file', issue: 'content mismatch' }]);
    }
    contentType = ALLOWED_TYPES[ext]![0]!;
  }
  if (input.declaredType && !TEXT_EXT.has(ext) && input.declaredType !== 'application/octet-stream' &&
      !ALLOWED_TYPES[ext]!.includes(input.declaredType)) {
    throw new AppError('VALIDATION_FAILED', 'Declared content type does not match file content', [{ field: 'file', issue: 'declared type mismatch' }]);
  }

  // quota (row-locked so concurrent uploads cannot oversubscribe)
  await trx('storage_usage').insert({ organization_id: input.organizationId, bytes_used: 0 }).onConflict('organization_id').ignore();
  const usage = await trx('storage_usage').where({ organization_id: input.organizationId }).forUpdate().first();
  const quota = await quotaFor(svc, trx, input.organizationId);
  if (Number(usage.bytes_used) + input.data.length > quota) {
    throw new AppError('VALIDATION_FAILED', 'Storage quota exceeded', [{ field: 'file', issue: 'quota_exceeded' }]);
  }

  const id = newId();
  const objectKey = `${input.organizationId}/${randomToken(24)}`; // random: never derived from the user filename
  await svc.storage.put(objectKey, input.data);
  await trx('files').insert({
    id, organization_id: input.organizationId, owner_id: input.ownerId, object_key: objectKey,
    original_filename: input.filename.slice(0, 255), content_type: contentType, size: input.data.length,
    sha256: sha256(input.data), scan_status: 'pending', purpose: input.purpose ?? 'general', created_by: input.ownerId,
  });
  await trx('storage_usage').where({ organization_id: input.organizationId }).increment('bytes_used', input.data.length).update({ updated_at: svc.now() });
  await svc.events.emit(trx, 'file.uploaded', input.organizationId, { fileId: id });
  return { id, filename: input.filename, contentType, size: input.data.length, scanStatus: 'pending' };
}

export function fileDto(f: Record<string, unknown>) {
  return {
    id: f.id, filename: f.original_filename, contentType: f.content_type, size: Number(f.size), sha256: f.sha256,
    scanStatus: f.scan_status, purpose: f.purpose, ownerId: f.owner_id, createdAt: new Date(f.created_at as string).toISOString(),
    previewable: f.scan_status === 'clean' && PREVIEWABLE.has(f.content_type as string),
  };
}

/** Fail closed: only `clean` files are ever downloadable. */
export function assertDownloadable(f: { scan_status: string; deleted_at?: unknown }): void {
  if (f.deleted_at) throw new AppError('NOT_FOUND', 'File not found');
  if (f.scan_status !== 'clean') throw new AppError('CONFLICT', `File is not available (scan status: ${f.scan_status})`);
}

const LINK_TTL_SECONDS = 300;

export function signDownload(secret: string, fileId: string, organizationId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const payload = `${fileId}.${organizationId}.${exp}`;
  return { token: `${Buffer.from(payload).toString('base64url')}.${hmac(secret, payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyDownload(secret: string, token: string, now = Date.now()): { fileId: string; organizationId: string } | null {
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  let payload: string;
  try { payload = Buffer.from(p, 'base64url').toString('utf8'); } catch { return null; }
  if (!safeEqual(hmac(secret, payload), sig)) return null;
  const [fileId, organizationId, exp] = payload.split('.');
  if (!fileId || !organizationId || Number(exp) < Math.floor(now / 1000)) return null;
  return { fileId, organizationId };
}

// scan worker: updates scan_status; any failure leaves the file blocked (`failed`)
jobRegistrars.push((svc) => {
  svc.events.on('file.uploaded', async (e) => {
    await svc.jobs.enqueue('scan', { fileId: e.payload.fileId as string, organizationId: e.organizationId });
  });
  svc.jobs.work('scan', async (data) => {
    const fileId = data.fileId as string;
    await withPlatformScope(svc.db, 'file-scan', async (t) => {
      const f = await t('files').where({ id: fileId }).first();
      if (!f) return;
      let status: 'clean' | 'infected' | 'failed';
      try {
        status = await scanner.scan(await svc.storage.get(f.object_key));
      } catch {
        status = 'failed';
      }
      await t('files').where({ id: fileId }).update({ scan_status: status });
    });
  });
});
