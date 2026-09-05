import { type Command, type ControlPlaneToNode, LIMITS, type NodeKind } from "@tabframe/protocol";
import { StoreClient } from "@tabframe/store";
import {
  type Log,
  NodeConnection,
  resolveStoreBase,
  type SocketLike,
  type Timers,
  type Welcome,
} from "./connection.ts";
import { SocketPresigner } from "./presign.ts";
import type { FetchLike } from "./session.ts";
import { TaskLoop } from "./task-loop.ts";
import { type SandboxRunner, TaskRunner } from "./tasks.ts";

export {
  OFF_POLL_MS,
  parseRotating,
  resolveStoreBase,
  type SocketLike,
  type Timers,
} from "./connection.ts";
export { THROTTLE_FACTOR, THROTTLE_MIN_MS } from "./task-loop.ts";

export type NodeState =
  | "connecting"
  | "idle"
  | "busy"
  | "frozen"
  | "throttled"
  | "closed"
  | "off"
  | "outdated";

export interface Status {
  state: NodeState;
  nodeId: string | null;
  generation: number | null;
  endpoint: string | null;
  tasksDone: number;
  lastTaskMs: number | null;
  attempts: number;
  /** Tasks accepted and not yet finished, the running one included. */
  queue: number;
  detail?: string;
}

export interface OrchestratorDeps {
  sessionUrl: string;
  hostId: string;
  /** A cloud core's proof of identity; tabs have none. */
  coreToken?: string;
  kind: NodeKind;
  cores: number;
  sandboxVersion: string;
  fetch: FetchLike;
  connect: (url: string, protocols?: string[]) => SocketLike;
  timers: Timers;
  /** The platform's sandbox for a store base (a Web Worker or a worker thread). */
  createSandbox: (storeBase: string) => SandboxRunner;
  /** Blob traffic: GET by hash and presigned PUT. Defaults to the global fetch. */
  blobFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  compile?: (bytes: Uint8Array) => Promise<WebAssembly.Module>;
  now?: () => number;
  rng?: () => number;
  onStatus: (status: Status) => void;
  log?: Log;
}

/**
 * The orchestrator (design §4): a connection (session, hello, heartbeat, reconnect) and a task
 * loop (accept, run one at a time, upload, report) composed into one node. Commands from the
 * dashboard act on both; the status the platform shows is assembled here.
 */
export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly connection: NodeConnection;
  private readonly loop: TaskLoop;
  private readonly presigner: SocketPresigner;
  private visible = true;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.presigner = new SocketPresigner((text) => this.connection.send(text));
    this.loop = new TaskLoop({
      timers: deps.timers,
      createRunner: (storeBase) => this.createRunner(storeBase),
      link: () => this.connection.link(),
      onChange: () => this.emit(),
      log: deps.log,
    });
    this.connection = new NodeConnection({
      sessionUrl: deps.sessionUrl,
      fetch: deps.fetch,
      connect: deps.connect,
      timers: deps.timers,
      rng: deps.rng,
      hello: () => ({
        hostId: deps.hostId,
        kind: deps.kind,
        cores: deps.cores,
        sandboxVersion: deps.sandboxVersion,
        ...(deps.coreToken ? { coreToken: deps.coreToken } : {}),
      }),
      heartbeat: () =>
        this.loop.frozen
          ? null
          : {
              visible: this.visible,
              queue: Math.min(this.loop.held(), LIMITS.maxInFlight),
              lastTaskMs: this.loop.lastTaskMs,
              tasksDone: this.loop.tasksDone,
            },
      onWelcome: (msg) => this.onWelcome(msg),
      onMessage: (msg) => this.onMessage(msg),
      onClosed: () => {
        this.presigner.reset();
        this.loop.disconnect();
      },
      onStatus: (state, detail) => this.status(state, detail),
      log: deps.log,
    });
  }

  get currentNodeId(): string | null {
    return this.connection.nodeId;
  }

  /** Begin the connect loop. Resolves once the first connection attempt is underway. */
  async start(): Promise<void> {
    this.loop.start();
    await this.connection.start();
  }

  /** Leave for good: no reconnect. Looks like a tab close to the control plane. */
  stop(): void {
    this.connection.stop();
    this.loop.stop();
    this.presigner.reset();
    this.status("closed");
  }

  /** The host tab reports its visibility; the next heartbeat carries it. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.connection.connected && this.connection.nodeId) this.emit();
  }

  private onWelcome(msg: Welcome): void {
    this.loop.configure(
      msg.maxInFlight,
      resolveStoreBase(msg.storeBase, this.connection.endpoint ?? ""),
    );
    this.presigner.setGeneration(this.connection.generation ?? 0);
    this.emit();
  }

  private onMessage(msg: Exclude<ControlPlaneToNode, Welcome>): void {
    switch (msg.t) {
      case "assign":
        if (this.loop.accept(msg)) this.emit();
        return;
      case "cancel":
        this.loop.cancel(msg.taskId);
        this.emit();
        return;
      case "command":
        this.onCommand(msg);
        return;
      case "presigned":
        if (!this.presigner.deliver(msg.urls)) this.deps.log?.("stray-presigned");
        return;
    }
  }

  private onCommand(msg: Command): void {
    switch (msg.op) {
      case "close":
        this.stop();
        return;
      case "freeze":
        // Looks dead to the control plane: no heartbeats, no results, socket left open.
        this.loop.freeze();
        this.connection.pauseHeartbeat();
        this.status("frozen", "frozen by an operator");
        return;
      case "throttle":
        this.loop.throttle();
        this.status(this.loop.state(this.visible), "throttled by an operator");
        return;
      case "resume":
        this.loop.resume();
        this.connection.resumeHeartbeat();
        this.emit();
        return;
    }
  }

  private createRunner(storeBase: string): TaskRunner {
    const blobFetch = this.deps.blobFetch ?? ((u, i) => fetch(u, i));
    return new TaskRunner({
      store: new StoreClient({ base: storeBase, presign: this.presigner, fetch: blobFetch }),
      createSandbox: () => this.deps.createSandbox(storeBase),
      compile: this.deps.compile ?? ((bytes) => WebAssembly.compile(bytes as BufferSource)),
      now: this.deps.now ?? (() => Date.now()),
      log: this.deps.log,
    });
  }

  private emit(): void {
    this.status(this.loop.state(this.visible));
  }

  private status(state: NodeState, detail?: string): void {
    const s: Status = {
      state,
      nodeId: this.connection.nodeId,
      generation: this.connection.generation,
      endpoint: this.connection.endpoint,
      tasksDone: this.loop.tasksDone,
      lastTaskMs: this.loop.lastTaskMs,
      attempts: this.connection.attempts,
      queue: this.loop.held(),
    };
    if (detail !== undefined) s.detail = detail;
    this.deps.onStatus(s);
  }
}
