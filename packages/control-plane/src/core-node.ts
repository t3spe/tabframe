// A cloud core's node (design §9.3): the same orchestrator a browser tab runs, started inside the
// image when the run payload says `role: core`. Its host id names the MicroVM, which is how the
// control plane links the node to the core it launched (§6.8).
import { Orchestrator, type Status } from "@tabframe/node";
import { nodeDeps } from "@tabframe/node/platform/node-deps";

export interface CoreOptions {
  sessionUrl: string;
  microvmId: string | null;
  /** The run payload's core token, shown at hello. */
  coreToken?: string | null;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Test seam: skip the real sockets. */
  start?: boolean;
  /** The sandbox worker entry; defaults to `TABFRAME_SANDBOX_WORKER` or the package's source. */
  workerFile?: string;
}

export function startCore(opts: CoreOptions): Orchestrator {
  const hostId = `core-${opts.microvmId ?? `unknown-${process.pid}`}`;
  const orchestrator = new Orchestrator(
    nodeDeps({
      sessionUrl: opts.sessionUrl,
      hostId,
      coreToken: opts.coreToken,
      workerFile: opts.workerFile,
      onStatus: (status: Status) => {
        opts.log("core-status", {
          state: status.state,
          nodeId: status.nodeId,
          queue: status.queue,
        });
      },
      log: (event, fields) => opts.log(`core-${event}`, fields),
    }),
  );
  if (opts.start !== false) void orchestrator.start();
  return orchestrator;
}
