import { S3Client } from "@aws-sdk/client-s3";

/** The caller's client when given, else one for the region (the SDK's default chain without one). */
export function s3Client(opts: {
  region?: string | undefined;
  client?: S3Client | undefined;
}): S3Client {
  return opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
}

/** The SDK's spellings of "no such object": HeadObject and GetObject name it differently. */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
