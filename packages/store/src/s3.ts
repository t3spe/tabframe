import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PresignedUpload, PresignItem, StoreDriver } from "./driver.ts";
import { hexToBase64, sha256Hex } from "./hash.ts";

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
    this.s3 = opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
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
        if (await this.exists(it.hash)) return { hash: it.hash, url: null, headers: {} };
        const input = {
          Bucket: this.bucket,
          Key: S3Store.key(it.hash),
          ContentType: "application/octet-stream",
          CacheControl: IMMUTABLE,
          ContentLength: it.size,
          ChecksumSHA256: hexToBase64(it.hash),
        };
        const url = await getSignedUrl(this.s3, new PutObjectCommand(input), {
          expiresIn: this.expiresIn,
        });
        return { hash: it.hash, url, headers: signedHeaders(url, input) };
      }),
    );
  }

  async get(hash: string): Promise<Uint8Array | null> {
    try {
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
 * The headers a client must send with a presigned PUT: exactly the ones the signature covers.
 * They are listed in the URL's X-Amz-SignedHeaders; the values come from the command input.
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
  // The checksum pin is the point; send it even if a signer version leaves it out of the list.
  out["x-amz-checksum-sha256"] = input.ChecksumSHA256;
  return out;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
