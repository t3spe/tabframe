import type { IncomingMessage, ServerResponse } from "node:http";
import { LIMITS } from "@tabframe/protocol";
import { HASH_RE, type LocalStore, parseRange } from "@tabframe/store";
import { readBody, send, sendJson } from "./http.ts";
import { serveStatic } from "./static.ts";

/** The local blob route accepts what the protocol allows an output to be. */
export const MAX_BLOB_BYTES = LIMITS.maxOutputBytes;

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface PublicRouterDeps {
  /** Local mode serves the session, the page config and the blobs itself; in the image the fleet and CloudFront do. */
  local: LocalStore | null;
  /** What the emulated session endpoint answers. */
  session: () => unknown;
  webDir: string | null;
}

export function createPublicRouter(deps: PublicRouterDeps): Handler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (deps.local) {
      if (url.pathname === "/session" && req.method === "GET")
        return sendJson(res, 200, deps.session());
      if (url.pathname === "/config.json") return sendJson(res, 200, { sessionUrl: "/session" });
      if (url.pathname.startsWith("/blob/"))
        return handleBlob(deps.local, url.pathname.slice(6), req, res);
    }
    return serveStatic(deps.webDir, req, res);
  };
}

/** The local store over HTTP: hash-verified PUT, GET with ranges, HEAD. */
export async function handleBlob(
  local: LocalStore,
  hash: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!HASH_RE.test(hash)) return send(res, 400, "text/plain", "not a sha-256 hex key");
  if (req.method === "PUT") {
    const body = await readBody(req, MAX_BLOB_BYTES);
    if (!body) return send(res, 413, "text/plain", "blob too large");
    const r = await local.putVerified(hash, body);
    if (!r.ok) return sendJson(res, 400, { error: "bytes do not hash to key", actual: r.actual });
    return sendJson(res, 200, { hash, size: r.size });
  }
  const bytes = local.getSync(hash);
  if (!bytes) return send(res, 404, "text/plain", "unknown blob");
  const headers: Record<string, string | number> = {
    "content-type": "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
  };
  if (req.method === "HEAD") {
    res.writeHead(200, { ...headers, "content-length": bytes.length });
    res.end();
    return;
  }
  const range = parseRange(req.headers.range, bytes.length);
  if (range === null) {
    res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
    res.end();
    return;
  }
  if (range) {
    const slice = bytes.subarray(range.start, range.end + 1);
    res.writeHead(206, {
      ...headers,
      "content-length": slice.length,
      "content-range": `bytes ${range.start}-${range.end}/${bytes.length}`,
    });
    res.end(slice);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": bytes.length });
  res.end(bytes);
}
