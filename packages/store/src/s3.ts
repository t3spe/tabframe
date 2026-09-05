import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PresignedUpload, PresignItem, StoreDriver } from "./driver.ts";
import { BlobTooLarge } from "./driver.ts";
import { hexToBase64, sha256Hex } from "./hash.ts";
import { isNotFound, s3Client } from "./s3-common.ts";

export const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * S3 behind CloudFront (design §7.1, §9.1). Keys are `blob/<hash>`; uploads are presigned PUTs
 * with the SHA-256 checksum pinned, so S3 itself refuses bytes that do not hash to the key.
 */
export class S3Store implements StoreDriver {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly base: string;
  private readonly expiresIn: number;

  constructor(opts: {
    bucket: string;
    base: string;
    region?: string;
    client?: S3Client;
    expiresInSeconds?: number;
  }) {
    this.bucket = opts.bucket;
    this.base = opts.base.replace(/\/$/, "");
    this.s3 = s3Client(opts);
    this.expiresIn = opts.expiresInSeconds ?? 300;
  }

  static key(hash: string): string {
    return `blob/${hash}`;
  }

  urlFor(hash: string): string {
    return `${this.base}/${hash}`;
  }

  async exists(hash: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: S3Store.key(hash) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async presign(items: PresignItem[]): Promise<PresignedUpload[]> {
    return Promise.all(
      items.map(async (it) => {
        // A HeadObject that fails for any reason but "not found" must not fail the presign, or the
        // node hangs on it; signing anyway is safe because the upload is idempotent by hash.
        if (await this.exists(it.hash).catch(() => false))
          return { hash: it.hash, url: null, headers: {} };
        const input = {
          Bucket: this.bucket,
          Key: S3Store.key(it.hash),
          ContentType: "application/octet-stream",
          CacheControl: IMMUTABLE,
          ContentLength: it.size,
          ChecksumSHA256: hexToBase64(it.hash),
        };
        // The checksum must be a *signed header*: S3 enforces the pin only then, and accepts but
        // ignores it when hoisted into the query. The size is signed too, so a presign for one
        // byte cannot accept a 5 GB object; browsers and undici send Content-Length themselves,
        // which is why signedHeaders() leaves it out.
        const url = await getSignedUrl(this.s3, new PutObjectCommand(input), {
          expiresIn: this.expiresIn,
          unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
          signableHeaders: new Set(["x-amz-checksum-sha256", "content-length"]),
        });
        const headers = signedHeaders(url, input);
        if (!headers["x-amz-checksum-sha256"]) {
          throw new Error(
            "presigned URL does not sign the checksum header; refusing to hand it out",
          );
        }
        return { hash: it.hash, url, headers };
      }),
    );
  }

  async get(hash: string, maxBytes?: number): Promise<Uint8Array | null> {
    try {
      if (maxBytes !== undefined) {
        // The size first: a hash an untrusted party named must not pull a gigabyte into a
        // one-gigabyte MicroVM.
        const head = await this.s3.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: S3Store.key(hash) }),
        );
        const size = head.ContentLength ?? 0;
        if (size > maxBytes) throw new BlobTooLarge(hash, size, maxBytes);
      }
      const r = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: S3Store.key(hash) }),
      );
      const bytes = await r.Body?.transformToByteArray();
      return bytes ? new Uint8Array(bytes) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    if (await this.exists(hash)) return hash;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: S3Store.key(hash),
        Body: bytes,
        ContentType: "application/octet-stream",
        CacheControl: IMMUTABLE,
        ChecksumSHA256: hexToBase64(hash),
      }),
    );
    return hash;
  }
}

/**
 * The headers a client must send with a presigned PUT: exactly the ones the signature covers,
 * read off the URL's X-Amz-SignedHeaders. S3 refuses a request carrying an unsigned x-amz-*
 * header, so nothing beyond the signed set may be added.
 */
export function signedHeaders(
  url: string,
  input: {
    ContentType: string;
    CacheControl: string;
    ContentLength: number;
    ChecksumSHA256: string;
  },
): Record<string, string> {
  const signed = (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
  const known: Record<string, string> = {
    "content-type": input.ContentType,
    "cache-control": input.CacheControl,
    "content-length": String(input.ContentLength),
    "x-amz-checksum-sha256": input.ChecksumSHA256,
    "x-amz-sdk-checksum-algorithm": "SHA256",
  };
  const out: Record<string, string> = {};
  for (const name of signed) {
    const v = known[name];
    if (v !== undefined && name !== "host" && name !== "content-length") out[name] = v;
  }
  return out;
}
