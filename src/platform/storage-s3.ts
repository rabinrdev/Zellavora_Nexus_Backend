import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageProvider } from './storage.js';

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string; // MinIO / other S3-compatible stores
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

/** Minimal client surface so tests can inject a fake without network access. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

/** Private object storage on S3-compatible services. Objects are never public; access goes through the API. */
export class S3Storage implements StorageProvider {
  private readonly client: S3Like;
  constructor(private readonly opts: S3Options, client?: S3Like) {
    this.client =
      client ??
      new S3Client({
        region: opts.region,
        endpoint: opts.endpoint,
        forcePathStyle: opts.forcePathStyle ?? !!opts.endpoint,
        credentials: opts.accessKeyId && opts.secretAccessKey ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } : undefined,
      });
  }

  private key(k: string): string {
    if (k.includes('..') || k.startsWith('/')) throw new Error('Invalid storage key'); // traversal guard
    return `${this.opts.prefix ?? ''}${k}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.opts.bucket, Key: this.key(key), Body: data, ServerSideEncryption: 'AES256', ContentType: 'application/octet-stream',
    }));
  }

  async get(key: string): Promise<Buffer> {
    const res = (await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }))) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
    };
    if (!res.Body) throw new Error('Object not found');
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }));
      return true;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }
}
