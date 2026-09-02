import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const FALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Tabframe</title>
<body style="font:14px system-ui;padding:2rem;background:#111;color:#ddd">
<h1>Tabframe control plane</h1><p>The web bundle is not built. Run <code>mise run build:web</code> or <code>mise run dev</code>.</p>
<p><a href="/health" style="color:#8cf">/health</a></p></body>`;

/**
 * Serve the web bundle from a directory, refusing anything outside it. Missing directory or
 * file falls back to index.html for the root, or 404.
 */
export async function serveStatic(
  webDir: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  if (!webDir) {
    if (rel === "/index.html") return send(res, 200, "text/html; charset=utf-8", FALLBACK_PAGE);
    return send(res, 404, "text/plain", "not found");
  }
  const root = path.resolve(webDir);
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(`${root}${path.sep}`) && file !== root)
    return send(res, 403, "text/plain", "forbidden");
  try {
    const data = await fs.readFile(file);
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    const cache =
      rel === "/index.html" || rel.endsWith(".json")
        ? "no-cache"
        : "public, max-age=31536000, immutable";
    res.writeHead(200, {
      "content-type": type,
      "content-length": data.length,
      "cache-control": cache,
    });
    res.end(data);
  } catch {
    if (rel === "/index.html") return send(res, 200, "text/html; charset=utf-8", FALLBACK_PAGE);
    send(res, 404, "text/plain", "not found");
  }
}

export function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Uint8Array,
): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

/**
 * Read a request body up to a cap. Oversized bodies return null; the stream is drained rather
 * than abandoned so the response is delivered the same way on every runtime.
 */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers["content-length"] ?? "0");
  let oversized = Number.isFinite(declared) && declared > maxBytes;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    if (oversized) continue;
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buf);
  }
  return oversized ? null : new Uint8Array(Buffer.concat(chunks));
}
