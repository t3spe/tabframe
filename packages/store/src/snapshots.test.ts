import { describe, expect, test } from "bun:test";
import { MemorySnapshots, S3Snapshots } from "./snapshots.ts";

describe("MemorySnapshots", () => {
  test("write, overwrite, read, missing", async () => {
    const m = new MemorySnapshots();
    expect(await m.read("a")).toBeNull();
    await m.write("a", new Uint8Array([1]));
    await m.write("a", new Uint8Array([2, 3]));
    expect(await m.read("a")).toEqual(new Uint8Array([2, 3]));
    expect(m.keys()).toEqual(["a"]);
  });
});

describe("S3Snapshots", () => {
  test("writes a keyed object with a content type and reads it back", async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const objects = new Map<string, Uint8Array>();
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "PutObjectCommand") {
          objects.set(cmd.input.Key as string, cmd.input.Body as Uint8Array);
          return {};
        }
        const body = objects.get(cmd.input.Key as string);
        if (!body) {
          const err = new Error("no such key") as Error & { name: string };
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: { transformToByteArray: async () => body } };
      },
    };
    const s = new S3Snapshots({ bucket: "b", client: client as never });
    await s.write("g1/x.json.gz", new Uint8Array([9]));
    expect(sent[0]?.input).toMatchObject({
      Bucket: "b",
      Key: "g1/x.json.gz",
      ContentType: "application/gzip",
    });
    expect(await s.read("g1/x.json.gz")).toEqual(new Uint8Array([9]));
    expect(await s.read("nope")).toBeNull();
  });

  test("other errors propagate", async () => {
    const client = {
      send: async () => {
        throw new Error("access denied");
      },
    };
    const s = new S3Snapshots({ bucket: "b", client: client as never });
    await expect(s.read("k")).rejects.toThrow("access denied");
  });
});
