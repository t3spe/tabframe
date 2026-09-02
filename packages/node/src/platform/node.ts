/**
 * Node platform: one process is one node. Cloud cores run this inside the MicroVM image; the local
 * dev topology runs two of them as stand-ins. Status goes to stdout as JSON lines.
 */
import { hostname } from "node:os";
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

const orchestrator = new Orchestrator({
  sessionUrl,
  hostId,
  kind: "core",
  cores: 1,
  sandboxVersion: "0",
  fetch: (url) => fetch(url),
  connect: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
  timers: {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  },
  onStatus: (status: Status) => {
    emit("status", { ...status });
    if (status.state === "outdated") process.exit(3);
    if (status.state === "off") process.exit(0);
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
