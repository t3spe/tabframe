import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { LocalStore } from "@tabframe/store";
import { closeServer, listen } from "./http.ts";
import { createPublicRouter } from "./routes-public.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const servers: Server[] = [];

async function serve(local: LocalStore | null): Promise<string> {
  const router = createPublicRouter({
    local,
    session: () => ({ endpoint: "ws://x", token: "local", generation: 2 }),
    webDir: null,
  });
  const server = createServer((req, res) => void router(req, res));
  servers.push(server);
  const addr = await listen(server, 0, "127.0.0.1");
  return `http://127.0.0.1:${addr.port}`;
}

let local = "";
let image = "";
beforeAll(async () => {
  local = await serve(new LocalStore("http://x/blob"));
  image = await serve(null);
});
afterAll(async () => {
  for (const s of servers) await closeServer(s);
});

describe("the public routes in local mode", () => {
  test("session and config.json are emulated", async () => {
    expect(await (await fetch(`${local}/session`)).json()).toEqual({
      endpoint: "ws://x",
      token: "local",
      generation: 2,
    });
    expect(await (await fetch(`${local}/config.json`)).json()).toEqual({ sessionUrl: "/session" });
    expect((await fetch(`${local}/session`, { method: "POST" })).status).toBe(404);
  });

  test("blobs: hash-verified PUT, GET, HEAD, Range, 416, 404, 400", async () => {
    const bytes = new TextEncoder().encode("hello tabframe store");
    const hash = sha(bytes);
    const bad = await fetch(`${local}/blob/${hash}`, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { actual: string }).actual).toBe(sha(new Uint8Array([1, 2, 3])));
    const ok = await fetch(`${local}/blob/${hash}`, { method: "PUT", body: bytes });
    expect(await ok.json()).toEqual({ hash, size: bytes.length });
    const got = await fetch(`${local}/blob/${hash}`);
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(got.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    const head = await fetch(`${local}/blob/${hash}`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    const part = await fetch(`${local}/blob/${hash}`, { headers: { range: "bytes=6-13" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 6-13/${bytes.length}`);
    expect(await part.text()).toBe("tabframe");
    const beyond = await fetch(`${local}/blob/${hash}`, { headers: { range: "bytes=50-60" } });
    expect(beyond.status).toBe(416);
    expect((await fetch(`${local}/blob/${"0".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${local}/blob/not-a-hash`)).status).toBe(400);
  });

  test("everything else is the static fallback", async () => {
    expect(await (await fetch(`${local}/`)).text()).toContain("web bundle is not built");
    expect((await fetch(`${local}/nope.js`)).status).toBe(404);
  });
});

describe("the public routes in image mode", () => {
  test("leave the session and the blobs to the fleet and CloudFront", async () => {
    expect((await fetch(`${image}/session`)).status).toBe(404);
    expect((await fetch(`${image}/config.json`)).status).toBe(404);
    expect((await fetch(`${image}/blob/${"0".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${image}/`)).status).toBe(200);
  });
});
