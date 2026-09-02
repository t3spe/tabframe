/**
 * Node platform: one process is one node. Cloud cores run this inside the MicroVM image; the local
 * dev topology runs two of them as stand-ins. Status goes to stdout as JSON lines. A close command
 * ends the process; whoever supervises it (the fleet policy, the dev runner) brings a fresh one.
 */
import { hostname } from "node:os";
import { createNodeSandboxHost } from "@tabframe/sandbox/adapters/node-host";
import { StoreClient } from "@tabframe/store";
import { Orchestrator, type SocketLike, type Status } from "../orchestrator.ts";

const sessionUrl = process.env.TABFRAME_SESSION_URL;
if (!sessionUrl) {
  console.error("TABFRAME_SESSION_URL is required");
  process.exit(2);
}
const hostId = process.env.TABFRAME_HOST_ID ?? `core-${hostname()}-${process.pid}`;

function emit(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

/** The sandbox worker thread reads blobs through the orchestrator's store client. */
export function blobReaderFor(storeBase: string) {
  const reads = new StoreClient(storeBase, {
    presign: () => Promise.reject(new Error("read-only client")),
  });
  return async (hash: string, offset: number, len: number): Promise<Uint8Array | null> => {
    if (offset === 0 && !Number.isFinite(len)) return reads.get(hash);
    if (Number.isFinite(len)) return reads.get(hash, { offset, length: len });
    const whole = await reads.get(hash);
    return whole ? whole.slice(offset) : null;
  };
}

const orchestrator = new Orchestrator({
  sessionUrl,
  hostId,
  kind: "core",
  cores: 1,
  sandboxVersion: "1",
  fetch: (url) => fetch(url),
  connect: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
  timers: {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  },
  createSandbox: (storeBase) => createNodeSandboxHost({ fetchBlob: blobReaderFor(storeBase) }),
  onStatus: (status: Status) => {
    emit("status", { ...status });
    if (status.state === "outdated") process.exit(3);
    if (status.state === "off") process.exit(0);
    if (status.state === "closed") process.exit(0);
  },
  log: emit,
});

void orchestrator.start();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    orchestrator.stop();
    process.exit(0);
  });
}
