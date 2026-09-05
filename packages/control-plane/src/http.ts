import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { log } from "./log.ts";

export interface Address {
  host: string;
  port: number;
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

/** Listen and report the bound address; port 0 picks a free one. */
export function listen(server: Server, port: number, host: string): Promise<Address> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      resolve({ host, port: addr.port });
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** A route that threw: a 500 unless headers already went out. */
export function fail(res: ServerResponse, err: unknown): void {
  log("request-error", { error: String(err) });
  if (!res.headersSent) sendJson(res, 500, { error: "internal" });
  else res.end();
}
