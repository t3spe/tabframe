/**
 * Node platform: one process is one node. The local dev topology runs two of them as stand-ins
 * for cloud cores (the image starts the same orchestrator from core-node.ts). Status goes to
 * stdout as JSON lines. A close command ends the process; whoever supervises it brings a fresh one.
 */
import { hostname } from "node:os";
import { Orchestrator } from "../orchestrator.ts";
import { nodeDeps } from "./node-deps.ts";

const sessionUrl = process.env.TABFRAME_SESSION_URL;
if (!sessionUrl) {
  console.error("TABFRAME_SESSION_URL is required");
  process.exit(2);
}
const hostId = process.env.TABFRAME_HOST_ID ?? `core-${hostname()}-${process.pid}`;

function emit(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

const orchestrator = new Orchestrator(
  nodeDeps({
    sessionUrl,
    hostId,
    log: emit,
    onStatus: (status) => {
      emit("status", { ...status });
      if (status.state === "outdated") process.exit(3);
      if (status.state === "off") process.exit(0);
      if (status.state === "closed") process.exit(0);
    },
  }),
);

void orchestrator.start();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    orchestrator.stop();
    process.exit(0);
  });
}
