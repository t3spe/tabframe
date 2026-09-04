import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PresignedUpload, PresignItem, StoreDriver } from "./driver.ts";
import { BlobTooLarge } from "./driver.ts";
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
        // A HeadObject that errors for any reason but "not found" (a throttle, a hiccup) must not
        // fail the whole presign (WP8.1): the node would hang on it for ever. Sign instead; the
        // upload is idempotent by hash.
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
        // The checksum must be a *signed header*, not a query parameter: S3 enforces the pin
        // only when the header is part of the signature (a tampered body is refused with a
        // checksum mismatch). Hoisted into the query it is accepted and ignored — verified
        // against the real bucket (WP1.10).
        const url = await getSignedUrl(this.s3, new PutObjectCommand(input), {
          expiresIn: this.expiresIn,
          unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
          // The size is signed too (WP8.2): a presign for "1 byte" must not accept a 5 GB object
          // whose key happens to be its own hash. Browsers and undici send Content-Length
          // themselves, so the client never sets it — signedHeaders() leaves it out on purpose.
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
        // Ask the size first (WP8.1): a hash an untrusted party named must not pull a gigabyte
        // into a one-gigabyte MicroVM.
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
  // Exactly the signed set and nothing more: S3 refuses a request carrying an unsigned
  // x-amz-* header ("headers present in the request which were not signed"). With the current
  // signer the checksum pin travels in the signed query string instead, and S3 enforces it
  // there (verified against the real bucket, WP1.10).
  return out;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
