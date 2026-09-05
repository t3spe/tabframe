import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { isNotFound, s3Client } from "./s3-common.ts";

/**
 * Keyed objects for ledger snapshots (design §9.4): not content-addressed, overwritten in place,
 * expired by the bucket's one-day rule. Memory locally, S3 in the image.
 */
export interface SnapshotStore {
  write(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
}

export class MemorySnapshots implements SnapshotStore {
  private readonly objects = new Map<string, Uint8Array>();

  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes);
  }

  async read(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}

export class S3Snapshots implements SnapshotStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(opts: { bucket: string; region?: string; client?: S3Client }) {
    this.bucket = opts.bucket;
    this.s3 = s3Client(opts);
  }

  async write(key: string, bytes: Uint8Array, contentType = "application/gzip"): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      return await out.Body.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}
