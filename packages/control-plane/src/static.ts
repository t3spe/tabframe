import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { LOCAL_PAGE_CSP } from "@tabframe/protocol";
import { send } from "./http.ts";

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
 * Serve the web bundle from a directory, refusing anything outside it. A missing directory or
 * file falls back to the placeholder page for the root, or 404.
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
    // Nothing here carries a content hash in its name, so nothing is immutable: pages, styles and
    // scripts are revalidated, or a protocol bump would lean on a reload.
    const cache =
      rel.endsWith(".html") || rel.endsWith(".json") || rel.endsWith(".js") || rel.endsWith(".css")
        ? "no-cache"
        : "public, max-age=86400";
    // The page runs under the deployed policy locally too, so the browser suites catch a script
    // or a connection the policy refuses before CloudFront does. Scripts carry it as well: a
    // worker's policy comes from its script's response.
    res.writeHead(200, {
      "content-type": type,
      "content-length": data.length,
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      ...(rel.endsWith(".html") || rel.endsWith(".js")
        ? { "content-security-policy": LOCAL_PAGE_CSP }
        : {}),
    });
    res.end(data);
  } catch {
    if (rel === "/index.html") return send(res, 200, "text/html; charset=utf-8", FALLBACK_PAGE);
    send(res, 404, "text/plain", "not found");
  }
}
