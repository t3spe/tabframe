import { describe, expect, test } from "bun:test";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { StoreClient } from "./client.ts";
import { HASH_RE, hex, hexToBase64, hexToBytes, sha256Hex } from "./hash.ts";
import { LocalStore, parseRange } from "./local.ts";
import { IMMUTABLE, S3Store, signedHeaders } from "./s3.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("hashing", () => {
  test("sha256 hex, hex/bytes/base64 conversions", async () => {
    const h = await sha256Hex(bytes("abc"));
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(HASH_RE.test(h)).toBe(true);
    expect(hex(hexToBytes(h))).toBe(h);
    expect(hexToBase64(h)).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });
});

describe("LocalStore", () => {
  test("put hashes, presign skips existing blobs, get and exists agree", async () => {
    const store = new LocalStore("http://x/blob");
    const h = await store.put(bytes("hello"));
    expect(await store.exists(h)).toBe(true);
    expect(await store.get(h)).toEqual(bytes("hello"));
    expect(store.urlFor(h)).toBe(`http://x/blob/${h}`);
    const other = await sha256Hex(bytes("other"));
    const pres = await store.presign([
      { hash: h, size: 5 },
      { hash: other, size: 5 },
    ]);
    expect(pres[0]?.url).toBeNull();
    expect(pres[1]?.url).toBe(`http://x/blob/${other}`);
    expect(await store.get(other)).toBeNull();
    expect(await store.putVerified(other, bytes("wrong"))).toMatchObject({ ok: false });
    expect(await store.putVerified(other, bytes("other"))).toEqual({ ok: true, size: 5 });
    expect(store.size).toBe(2);
  });
  test("parseRange", () => {
    expect(parseRange(undefined, 10)).toBeUndefined();
    expect(parseRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=12-", 10)).toBeNull();
  });
});

describe("S3Store", () => {
  const s3 = mockClient(S3Client);
  test("keys are blob/<hash>; exists maps 404 to false; presign pins the checksum and skips existing", async () => {
    s3.reset();
    const store = new S3Store({
      bucket: "b",
      base: "https://cdn/blob/",
      region: "us-west-2",
      client: new S3Client({
        region: "us-west-2",
        credentials: { accessKeyId: "x", secretAccessKey: "y" },
      }),
    });
    const h = await sha256Hex(bytes("tile"));
    expect(S3Store.key(h)).toBe(`blob/${h}`);
    expect(store.urlFor(h)).toBe(`https://cdn/blob/${h}`);
    s3.on(HeadObjectCommand).rejects({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
    expect(await store.exists(h)).toBe(false);
    const [p] = await store.presign([{ hash: h, size: 4 }]);
    expect(p?.url).toContain(`blob/${h}`);
    expect(p?.url).toContain("X-Amz-Signature=");
    expect(p?.headers["x-amz-checksum-sha256"]).toBe(hexToBase64(h));
    // The pin must be a *signed header*: hoisted into the query string S3 ignores it, so a
    // tampered body would be accepted (found against the real bucket, WP1.10).
    const signed = new URL(p?.url as string).searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed.split(";")).toContain("x-amz-checksum-sha256");
    expect(new URL(p?.url as string).searchParams.has("x-amz-checksum-sha256")).toBe(false);
    s3.on(HeadObjectCommand).resolves({});
    const [q] = await store.presign([{ hash: h, size: 4 }]);
    expect(q?.url).toBeNull();
  });
  test("get returns bytes or null; put pins the checksum and skips existing", async () => {
    s3.reset();
    const store = new S3Store({
      bucket: "b",
      base: "https://cdn/blob",
      client: new S3Client({
        region: "us-west-2",
        credentials: { accessKeyId: "x", secretAccessKey: "y" },
      }),
    });
    const h = await sha256Hex(bytes("tile"));
    s3.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => bytes("tile") } as never,
    });
    expect(await store.get(h)).toEqual(bytes("tile"));
    s3.on(GetObjectCommand).rejects({ name: "NoSuchKey" });
    expect(await store.get(h)).toBeNull();
    s3.on(HeadObjectCommand).rejects({ name: "NotFound" });
    s3.on(PutObjectCommand).resolves({});
    expect(await store.put(bytes("tile"))).toBe(h);
    const put = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(put?.Key).toBe(`blob/${h}`);
    expect(put?.ChecksumSHA256).toBe(hexToBase64(h));
    expect(put?.CacheControl).toBe(IMMUTABLE);
    s3.on(HeadObjectCommand).resolves({});
    expect(await store.put(bytes("tile"))).toBe(h);
    expect(s3.commandCalls(PutObjectCommand).length).toBe(1);
    s3.on(HeadObjectCommand).rejects({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    await expect(store.exists(h)).rejects.toBeDefined();
  });
  test("signedHeaders picks exactly the signed names", () => {
    const url =
      "https://b.s3.amazonaws.com/blob/x?X-Amz-SignedHeaders=cache-control%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256&X-Amz-Signature=s";
    const h = signedHeaders(url, {
      ContentType: "application/octet-stream",
      CacheControl: IMMUTABLE,
      ContentLength: 3,
      ChecksumSHA256: "abc=",
    });
    expect(h).toEqual({
      "cache-control": IMMUTABLE,
      "content-type": "application/octet-stream",
      "x-amz-checksum-sha256": "abc=",
    });
    // Nothing beyond the signed set: S3 refuses a request carrying an unsigned x-amz-* header.
    const unsigned = signedHeaders(
      "https://b.s3.amazonaws.com/blob/x?X-Amz-SignedHeaders=content-length%3Bhost&X-Amz-Signature=s",
      {
        ContentType: "application/octet-stream",
        CacheControl: IMMUTABLE,
        ContentLength: 3,
        ChecksumSHA256: "abc=",
      },
    );
    expect(unsigned).toEqual({});
  });
});

describe("StoreClient", () => {
  test("hashes locally, presigns once per unique blob, PUTs with the pinned headers, skips existing", async () => {
    const asked: Array<{ hash: string; size: number }[]> = [];
    const puts: Array<{ url: string; headers: Record<string, string>; size: number }> = [];
    const existing = await sha256Hex(bytes("old"));
    const client = new StoreClient(
      "https://cdn/blob/",
      {
        presign: async (items) => {
          asked.push(items);
          return items.map((it) => ({
            hash: it.hash,
            url: it.hash === existing ? null : `https://s3/${it.hash}`,
            headers: { "x-amz-checksum-sha256": "pin" },
          }));
        },
      },
      async (url, init) => {
        if (init?.method === "PUT") {
          puts.push({
            url,
            headers: init.headers as Record<string, string>,
            size: (init.body as Uint8Array).length,
          });
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    );
    const results = await client.putMany([bytes("new"), bytes("old"), bytes("new")]);
    expect(results.length).toBe(3);
    expect(asked[0]?.length).toBe(2);
    expect(puts.length).toBe(1);
    expect(puts[0]?.headers["x-amz-checksum-sha256"]).toBe("pin");
    expect(puts[0]?.size).toBe(3);
    expect(client.urlFor("h")).toBe("https://cdn/blob/h");
  });
  test("get returns bytes, null on 404, throws on other failures, and sends Range", async () => {
    const seen: string[] = [];
    const client = new StoreClient(
      "https://cdn/blob",
      { presign: async () => [] },
      async (url, init) => {
        seen.push(String((init?.headers as Record<string, string> | undefined)?.range ?? ""));
        if (url.endsWith("/missing")) return new Response(null, { status: 404 });
        if (url.endsWith("/broken")) return new Response(null, { status: 500 });
        return new Response(bytes("tile"), { status: 206 });
      },
    );
    expect(await client.get("ok", { offset: 2, length: 4 })).toEqual(bytes("tile"));
    expect(seen[0]).toBe("bytes=2-5");
    expect(await client.get("missing")).toBeNull();
    await expect(client.get("broken")).rejects.toThrow(/500/);
  });
  test("a failed PUT throws", async () => {
    const client = new StoreClient(
      "b",
      { presign: async (items) => items.map((it) => ({ hash: it.hash, url: "u", headers: {} })) },
      async () => new Response(null, { status: 403 }),
    );
    await expect(client.put(bytes("x"))).rejects.toThrow(/failed: 403/);
  });
});
