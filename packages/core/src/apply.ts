import {
  byteLength,
  CLOSE,
  type Control,
  type ControlPlaneToObserver,
  canonicalStringify,
  decode,
  type Heartbeat,
  type Hello,
  LIMITS,
  type MachineView,
  nodeToControlPlane,
  observerToControlPlane,
  PROTOCOL_VERSION,
  type ProgramView,
  type Snapshot,
  type TaskView,
} from "@tabframe/protocol";
import { BUDGETS, chargeLaunch, chargePresign, coolingDown, newBucket, take } from "./budgets.ts";
import type { Effect, Event } from "./events.ts";
import {
  addProgram,
  afterTaskSettled,
  cancelExecution,
  commandHalf,
  enqueue,
  ensureDefaultLoop,
  executionTasks,
  maybeStart,
  onInheritRoot,
  onManifestStored,
  onStageSpec,
  onStoreError,
  pruneExecutions,
  resumeAll,
  resumePending,
  retireProgram,
} from "./executions.ts";
import {
  cloudCoreGone,
  cloudCoreLaunched,
  fleetTick,
  microvmIdOfHost,
  unlinkCloudCore,
} from "./fleet.ts";
import {
  type ConnRole,
  type ExecutionRecord,
  executionView,
  type Ledger,
  type NodeRecord,
  nodeView,
  type ProgramRecord,
  queueEntry,
  taskView,
} from "./ledger.ts";
import { broadcast } from "./observers.ts";
import {
  CONTROL_COOLDOWN_MS,
  HANDOVER_LEASE_MS,
  HANDSHAKE_TIMEOUT_MS,
  HEALTH_ANNOUNCE_MS,
  OBSERVER_SILENCE_MS,
  SNAPSHOT_PAGE_BUDGET,
} from "./policy.ts";
import { onResult, settleExisting } from "./results.ts";
import { fill, relabelHealth, releaseNode } from "./scheduler.ts";

export interface ApplyOptions {
  /** Uniform random in [0, 1); victim selection for the demo controls. */
  rng?: () => number;
}

/**
 * The control plane as a function: one inbound event, the ledger updated in place, and the
 * effects the process must carry out. No I/O happens here; time is a parameter.
 */
export function apply(
  ledger: Ledger,
  event: Event,
  now: number,
  opts: ApplyOptions = {},
): Effect[] {
  const rng = opts.rng ?? Math.random;
  switch (event.kind) {
    case "connected":
      return onConnected(ledger, event.connId, event.role, now);
    case "message":
      return onMessage(ledger, event.connId, event.raw, now, rng);
    case "disconnected":
      return removeConnection(ledger, event.connId, "closed", now);
    case "tick":
      return tick(ledger, now);
    case "coreLaunched":
      return cloudCoreLaunched(ledger, event.microvmId, event.token, now);
    case "coreGone":
      return cloudCoreGone(ledger, event.microvmId);
    case "bundleRejected":
      return ledger.conns.has(event.connId)
        ? [
            {
              kind: "send",
              connId: event.connId,
              msg: errorMsg(ledger, "launch-refused", event.reason),
            },
          ]
        : [];
    case "programAdded":
      return [
        ...addProgram(ledger, event.bundle, event.module, event.manifest, event.files, now),
        ...ensureDefaultLoop(ledger, now),
      ];
    case "programRetired":
      return retireProgram(ledger, event.bundle);
    case "setDefaultLoop":
      ledger.config.defaultLoop = event.loop;
      return ensureDefaultLoop(ledger, now);
    case "launch": {
      const r = enqueue(
        ledger,
        { bundle: event.bundle, params: event.params, human: event.human, inherit: event.inherit },
        now,
      );
      if (r.error && event.connId) {
        return [
          { kind: "send", connId: event.connId, msg: errorMsg(ledger, "launch-refused", r.error) },
        ];
      }
      return [...r.effects, ...fill(ledger, now)];
    }
    case "blobFetched":
      if (event.error !== undefined && event.purpose.type !== "manifest")
        return onStoreError(ledger, event.purpose.executionId, event.error, now);
      if (event.purpose.type === "stageSpec")
        return onStageSpec(
          ledger,
          event.purpose.executionId,
          event.purpose.taskId,
          event.bytes,
          now,
        );
      if (event.purpose.type === "inheritRoot")
        return onInheritRoot(ledger, event.purpose.executionId, event.bytes, now);
      return [];
    case "blobStored":
      if (event.purpose.type === "manifest")
        return onManifestStored(
          ledger,
          event.purpose.executionId,
          event.purpose.stage,
          event.hash,
          now,
        );
      return [];
  }
}

function tick(ledger: Ledger, now: number): Effect[] {
  const effects = sweep(ledger, now);
  pruneExecutions(ledger);
  // A control plane that handed its ledger over acts on nothing until it is drained (WP8.1): no
  // fleet, no loop, no assignment — the successor owns all of that now. Unless the rotation died
  // between the handover and the promote, in which case the lease brings this one back.
  if (ledger.meta.phase === "handing-over") {
    if (ledger.session.handoverAt !== null && now - ledger.session.handoverAt > HANDOVER_LEASE_MS) {
      ledger.meta.phase = "active";
      ledger.session.handoverAt = null;
    } else return effects;
  }
  if (ledger.meta.phase === "drained") return effects;
  effects.push(...fleetTick(ledger, now));
  effects.push(...relabelHealth(ledger));
  effects.push(...ensureDefaultLoop(ledger, now));
  effects.push(...maybeStart(ledger, now)); // a queued continuation whose hold just expired
  effects.push(...fill(ledger, now));
  effects.push(...resumePending(ledger, now));
  return effects;
}

function onConnected(ledger: Ledger, connId: string, role: ConnRole, now: number): Effect[] {
  if (ledger.conns.has(connId)) return [];
  ledger.conns.set(connId, {
    connId,
    role,
    openedAt: now,
    messages: newBucket(role === "node" ? BUDGETS.nodeMessages : BUDGETS.observerMessages, now),
    solicited: newBucket(BUDGETS.solicited, now),
    presignBytes: newBucket(BUDGETS.presignBytes, now),
  });
  return [];
}

function onMessage(
  ledger: Ledger,
  connId: string,
  raw: unknown,
  now: number,
  rng: () => number,
): Effect[] {
  const conn = ledger.conns.get(connId);
  if (!conn) return [];

  const opts = { expectGen: ledger.meta.generation };
  if (conn.role === "node") {
    const d = decode(nodeToControlPlane, raw, opts);
    if (!d.ok) return refuse(ledger, connId, d.closeCode, d.reason, now);
    // Results and presigns answer assignments, which maxInFlight already paces (a fast node on
    // small tiles legitimately sends dozens a second); the bucket covers what a node sends on
    // its own initiative.
    const solicited = d.msg.t === "result" || d.msg.t === "presign";
    if (!solicited && !take(conn.messages, BUDGETS.nodeMessages, now))
      return refuse(ledger, connId, CLOSE.rateLimited, "message rate exceeded", now);
    // Results and presigns get a bucket of their own (WP8.1): generous, since maxInFlight paces an
    // honest node, but a bound — a node that says hello and floods presigns costs S3 calls.
    if (
      solicited &&
      !take(conn.solicited, BUDGETS.solicited, now, d.msg.t === "presign" ? d.msg.items.length : 1)
    )
      return refuse(ledger, connId, CLOSE.rateLimited, "result rate exceeded", now);
    switch (d.msg.t) {
      case "hello":
        return onHello(ledger, connId, d.msg, now);
      case "heartbeat":
        return onHeartbeat(ledger, connId, d.msg, now);
      case "result": {
        const node = nodeOf(ledger, connId);
        if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "result before hello", now);
        node.lastSeen = now;
        const { effects, settlement } = onResult(ledger, node, d.msg, now);
        if (settlement.kind === "done" || settlement.kind === "failed")
          effects.push(...afterTaskSettled(ledger, settlement.task, now));
        effects.push(...fill(ledger, now));
        return effects;
      }
      case "presign": {
        const node = nodeOf(ledger, connId);
        if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "presign before hello", now);
        node.lastSeen = now;
        // A connection over its own budget is closed; a machine over its budget answers with no
        // URLs (WP8.3), so an honest node's presign fails, its task is released and retried, and
        // the node stays connected — closing it for someone else's spending swapped its socket and
        // lost the result it was about to send.
        const charged = chargePresign(conn, ledger.session, d.msg.items, now);
        if (charged === "connection")
          return refuse(ledger, connId, CLOSE.rateLimited, "presign budget exhausted", now);
        if (charged === "machine") return [{ kind: "presign", connId, items: [] }];
        return [{ kind: "presign", connId, items: d.msg.items }];
      }
    }
  }
  const d = decode(observerToControlPlane, raw, opts);
  if (!d.ok) return refuse(ledger, connId, d.closeCode, d.reason, now);
  if (!take(conn.messages, BUDGETS.observerMessages, now))
    return refuse(ledger, connId, CLOSE.rateLimited, "message rate exceeded", now);
  switch (d.msg.t) {
    case "subscribe":
      return onSubscribe(ledger, connId, now);
    case "ping":
      return onPing(ledger, connId, now);
    case "presign":
      if (!ledger.observers.has(connId))
        return refuse(ledger, connId, CLOSE.invalidMessage, "presign before subscribe", now);
      {
        const charged = chargePresign(conn, ledger.session, d.msg.items, now);
        if (charged === "connection")
          return refuse(ledger, connId, CLOSE.rateLimited, "presign budget exhausted", now);
        if (charged === "machine")
          return [
            {
              kind: "send",
              connId,
              msg: errorMsg(
                ledger,
                "presign-budget",
                "the machine's upload budget for this minute is spent; try again shortly",
              ),
            },
          ];
        return [{ kind: "presign", connId, items: d.msg.items }];
      }
    default:
      if (!ledger.observers.has(connId))
        return refuse(ledger, connId, CLOSE.invalidMessage, "control before subscribe", now);
      ledger.meta.lastInteractionAt = now;
      return onControl(ledger, connId, d.msg, now, rng);
  }
}

// (WP8.3) skip and killExecution join the set: each ends every task of an execution at once, and at
// five messages a second one socket could end every execution as it started. The redundancy flip
// stays out: a person who toggles it and toggles it back within two seconds must get the second
// flip, or the checkbox shows a state the machine did not take (found by the browser suite, where a
// refused flip-back left redundancy on and a single-node plan task waiting for a twin for ever).
const DESTRUCTIVE = new Set([
  "killHalf",
  "freezeHalf",
  "throttleHalf",
  "restart",
  "stop",
  "skip",
  "killExecution",
]);

function onControl(
  ledger: Ledger,
  connId: string,
  msg: Control,
  now: number,
  rng: () => number,
): Effect[] {
  const running = ledger.running ? ledger.executions.get(ledger.running) : undefined;
  // Destructive controls at most once every few seconds machine-wide (WP8.1): a kill-half every
  // 200 ms would otherwise terminate and relaunch cloud cores in a loop that costs money.
  // Ending the running execution is destructive; dropping a queued one is not (WP8.3): a person
  // who kills a frame and then tidies the queue must not be told to wait two seconds.
  const destructive =
    DESTRUCTIVE.has(msg.t) && !(msg.t === "killExecution" && ledger.running !== msg.executionId);
  if (destructive) {
    const ago = coolingDown(ledger.session.lastControlAt, msg.t, now);
    if (ago !== null)
      return [
        {
          kind: "send",
          connId,
          msg: errorMsg(
            ledger,
            "cooldown",
            `${msg.t} was applied ${ago} ms ago; wait ${CONTROL_COOLDOWN_MS} ms`,
          ),
        },
      ];
  }
  switch (msg.t) {
    case "killHalf":
    case "freezeHalf":
    case "throttleHalf": {
      const op = msg.t === "killHalf" ? "close" : msg.t === "freezeHalf" ? "freeze" : "throttle";
      const { effects, victims } = commandHalf(ledger, op, rng);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: msg.t, nodeIds: victims }));
      return effects;
    }
    case "resumeAll": {
      const { effects, victims } = resumeAll(ledger);
      effects.push(
        ...broadcast(ledger, { t: "controlApplied", op: "resumeAll", nodeIds: victims }),
      );
      return effects;
    }
    case "restart": {
      if (!running) return [];
      const effects = cancelExecution(ledger, running, "restarted", now);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "restart", nodeIds: [] }));
      const relaunch = enqueue(
        ledger,
        {
          bundle: running.bundle,
          params: running.params,
          human: running.human,
          inherit: running.inheritedFrom,
        },
        now,
      );
      // A relaunch goes first whatever the queue holds.
      if (relaunch.executionId && ledger.queue.includes(relaunch.executionId)) {
        ledger.queue = [
          relaunch.executionId,
          ...ledger.queue.filter((id) => id !== relaunch.executionId),
        ];
      }
      effects.push(...relaunch.effects, ...maybeStart(ledger, now), ...fill(ledger, now));
      return effects;
    }
    case "skip": {
      if (!running) return [];
      const effects = cancelExecution(ledger, running, "skipped", now);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "skip", nodeIds: [] }));
      effects.push(
        ...ensureDefaultLoop(ledger, now),
        ...maybeStart(ledger, now),
        ...fill(ledger, now),
      );
      return effects;
    }
    case "killExecution": {
      const target = ledger.executions.get(msg.executionId);
      if (!target)
        return [
          { kind: "send", connId, msg: errorMsg(ledger, "unknown-execution", msg.executionId) },
        ];
      const effects = cancelExecution(ledger, target, "cancelled by an operator", now);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "killExecution", nodeIds: [] }));
      effects.push(
        ...ensureDefaultLoop(ledger, now),
        ...maybeStart(ledger, now),
        ...fill(ledger, now),
      );
      return effects;
    }
    case "launch": {
      const limited = launchRateExceeded(ledger, connId, now);
      if (limited)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "rate-limited", limited) }];
      if (!ledger.programs.has(msg.bundle)) {
        // An uploaded bundle: the process fetches and validates it, then launches (design §5.2).
        return [
          {
            kind: "resolveBundle",
            bundle: msg.bundle,
            connId,
            params: msg.params,
            inherit: msg.inherit,
          },
        ];
      }
      const r = enqueue(
        ledger,
        { bundle: msg.bundle, params: msg.params, human: true, inherit: msg.inherit },
        now,
      );
      if (r.error)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "launch-refused", r.error) }];
      return [...r.effects, ...fill(ledger, now)];
    }
    case "runFollowUp": {
      const limited = launchRateExceeded(ledger, connId, now);
      if (limited)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "rate-limited", limited) }];
      const done = ledger.executions.get(msg.executionId);
      if (done?.status !== "done" || !done.followUp)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "no-follow-up", msg.executionId) }];
      const r = enqueue(
        ledger,
        { bundle: done.bundle, params: done.followUp, human: true, inherit: done.executionId },
        now,
      );
      if (r.error)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "launch-refused", r.error) }];
      return [...r.effects, ...fill(ledger, now)];
    }
    case "setRedundancy": {
      ledger.meta.redundancy = msg.on;
      const effects = broadcast(ledger, { t: "controlApplied", op: "setRedundancy", nodeIds: [] });
      if (!msg.on) {
        // The toggle going off reaches open tasks too (WP8.1): one result is enough now, and a
        // task that already holds one settles on it, so a lone node is not left waiting for a twin.
        for (const task of ledger.tasks.values()) {
          if (task.status === "done" || task.status === "failed") continue;
          task.requiredAgreement = 1;
          const { effects: settled, settlement } = settleExisting(ledger, task, now);
          effects.push(...settled);
          if (settlement.kind === "done" || settlement.kind === "failed")
            effects.push(...afterTaskSettled(ledger, settlement.task, now));
        }
        effects.push(...fill(ledger, now));
      }
      return effects;
    }
    case "stop": {
      // A person wants the machine idle (WP6.1): the running execution ends, the loop's queued
      // continuations go, a person's own queued launches stay, and the loop waits for Start.
      const effects: Effect[] = [];
      ledger.meta.loopStopped = true;
      if (running) effects.push(...cancelExecution(ledger, running, "stopped by a person", now));
      for (const id of [...ledger.queue]) {
        const queued = ledger.executions.get(id);
        if (queued && !queued.human)
          effects.push(...cancelExecution(ledger, queued, "stopped by a person", now));
      }
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "stop", nodeIds: [] }));
      effects.push(...maybeStart(ledger, now), ...fill(ledger, now));
      return effects;
    }
    case "pause": {
      // The editor tab that asked holds the pause; nothing new is assigned or started until it
      // resumes or goes away (WP6.4). Asking twice from the same socket is one pause.
      const held = ledger.session.pausedBy;
      ledger.session.pausedBy = connId;
      if (held === connId) return [];
      return broadcast(ledger, { t: "controlApplied", op: "pause", nodeIds: [] });
    }
    case "resume":
      return resumeMachine(ledger, now);
    case "start": {
      ledger.meta.loopStopped = false;
      ledger.meta.loopYielded = false;
      ledger.meta.loopPausedUntil = 0; // a person asked now, not after a hold or a backoff
      ledger.meta.loopBackoffMs = 0;
      const effects = broadcast(ledger, { t: "controlApplied", op: "start", nodeIds: [] });
      effects.push(
        ...ensureDefaultLoop(ledger, now),
        ...maybeStart(ledger, now),
        ...fill(ledger, now),
      );
      return effects;
    }
  }
}

function errorMsg(ledger: Ledger, code: string, message: string): ControlPlaneToObserver {
  return { t: "error", v: PROTOCOL_VERSION, gen: ledger.meta.generation, code, message };
}

function onHello(ledger: Ledger, connId: string, msg: Hello, now: number): Effect[] {
  if (ledger.nodeByConn.has(connId))
    return refuse(ledger, connId, CLOSE.invalidMessage, "duplicate hello", now);
  if (ledger.nodes.size >= LIMITS.nodeCap)
    return refuse(ledger, connId, CLOSE.nodeCap, "node cap reached", now);

  const nodeId = `n${++ledger.meta.nodeCounter}`;
  const node: NodeRecord = {
    nodeId,
    connId,
    hostId: msg.hostId,
    kind: msg.kind,
    cores: msg.cores,
    sandboxVersion: msg.sandboxVersion,
    joinedAt: now,
    lastSeen: now,
    visible: true,
    health: "fast",
    tasksDone: 0,
    lastTaskMs: null,
    ewmaMs: null,
    inFlight: [],
    commanded: null,
    heartbeatAt: null,
    announcedHealth: null,
    healthAnnouncedAt: null,
  };
  ledger.nodes.set(nodeId, node);
  ledger.nodeByConn.set(connId, nodeId);
  // A cloud core names itself after its MicroVM and proves it with the token its run payload
  // carried (WP8.2): a hello links only a record the control plane launched, and only with the
  // token; nothing is created from a hello, so a visitor cannot name a core and get it terminated.
  const microvmId = microvmIdOfHost(msg.hostId);
  if (microvmId) {
    const core = ledger.cores.get(microvmId);
    // A token match, unconditionally (WP8.3): every launch since WP8.2 carries one, and a token-less
    // record inherited from an old snapshot must not be claimable by whoever names its id.
    if (core && core.token === msg.coreToken) {
      core.nodeId = nodeId;
      core.unlinkedAt = null;
    } else {
      ledger.nodes.delete(nodeId);
      ledger.nodeByConn.delete(connId);
      return refuse(ledger, connId, CLOSE.invalidMessage, "unknown core or bad core token", now);
    }
  }

  const effects: Effect[] = [
    {
      kind: "send",
      connId,
      msg: {
        t: "welcome",
        v: PROTOCOL_VERSION,
        gen: ledger.meta.generation,
        nodeId,
        heartbeatMs: LIMITS.heartbeatMs,
        maxInFlight: LIMITS.maxInFlight,
        storeBase: ledger.meta.storeBase,
      },
    },
  ];
  effects.push(...broadcast(ledger, { t: "nodeJoined", node: nodeView(node) }));
  effects.push(...fill(ledger, now));
  return effects;
}

function onHeartbeat(ledger: Ledger, connId: string, msg: Heartbeat, now: number): Effect[] {
  const node = nodeOf(ledger, connId);
  if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "heartbeat before hello", now);
  // A heartbeat arriving faster than half the heartbeat period is noise (WP8.3): one socket
  // alternating `visible` a thousand times a second used to fan out to every observer.
  if (node.heartbeatAt !== null && now - node.heartbeatAt < LIMITS.heartbeatMs / 2) return [];
  node.heartbeatAt = now;
  node.lastSeen = now;
  node.visible = msg.visible;
  const before = node.health;
  // Throttled is the one label the node's own evidence decides: its host tab is hidden.
  if (!msg.visible && node.health !== "throttled") node.health = "throttled";
  else if (msg.visible && node.health === "throttled") node.health = "fast";
  // Health is announced at most every two seconds per node (WP8.3); a flip inside the window is
  // announced by the next heartbeat that finds it still changed.
  const announced = node.announcedHealth ?? before;
  if (node.health !== announced) {
    if (now - (node.healthAnnouncedAt ?? 0) < HEALTH_ANNOUNCE_MS) return [];
    node.announcedHealth = node.health;
    node.healthAnnouncedAt = now;
    return broadcast(ledger, { t: "nodeHealth", nodeId: node.nodeId, health: node.health });
  }
  return [];
}

function onSubscribe(ledger: Ledger, connId: string, now: number): Effect[] {
  if (ledger.observers.has(connId))
    return refuse(ledger, connId, CLOSE.invalidMessage, "duplicate subscribe", now);
  if (ledger.observers.size >= LIMITS.observerCap)
    return refuse(ledger, connId, CLOSE.observerCap, "observer cap reached", now);
  ledger.observers.set(connId, { connId, subscribedAt: now, lastSeen: now, launchedAt: [] });
  ledger.meta.lastInteractionAt = now;
  const effects = snapshotPages(ledger, connId, now);
  effects.push(...ensureDefaultLoop(ledger, now));
  effects.push(...fill(ledger, now));
  return effects;
}

export function programView(p: ProgramRecord): ProgramView {
  return {
    bundle: p.bundle,
    name: p.manifest.name,
    view: p.manifest.view,
    description: p.manifest.description ?? null,
    defaultParams: p.manifest.defaultParams,
    addedAt: p.addedAt,
    source: p.manifest.source ?? null,
  };
}

function latestEnded(ledger: Ledger): ExecutionRecord | undefined {
  let latest: ExecutionRecord | undefined;
  for (const e of ledger.executions.values()) {
    if (e.endedAt === null) continue;
    if (!latest || e.endedAt > (latest.endedAt ?? 0)) latest = e;
  }
  return latest;
}

/**
 * Page 0 carries the cluster; every page carries task rows (design §8.3). Pages are packed by
 * bytes as well as by row count: a full frame of done tiles with two holders each does not fit
 * 256 rows under the message cap, and page 0 also carries up to 256 nodes.
 */
export function snapshotPages(ledger: Ledger, connId: string, now: number): Effect[] {
  // Nothing running: the snapshot shows the execution that ended last, so a visitor arriving
  // during the hold after a person's launch — or a dashboard resubscribing for a fresh snapshot —
  // sees the result on the stage rather than "idle" (WP4.4; the loop's hold is what makes the
  // window exist). Its tasks are still in the ledger for the two most recent frames.
  const exec = ledger.running ? ledger.executions.get(ledger.running) : latestEnded(ledger);
  const tasks = exec ? executionTasks(ledger, exec.executionId).map(taskView) : [];
  const machine: MachineView = {
    awake: ledger.meta.awake,
    reason: ledger.meta.sleepReason,
    redundancy: ledger.meta.redundancy,
    stopped: ledger.meta.loopStopped,
    paused: ledger.session.pausedBy !== null,
    yielded: ledger.meta.loopYielded,
    nextRotationAt: null,
    uptimeMs: Math.max(0, now - ledger.meta.startedAt),
  };
  const cluster = {
    nodes: [...ledger.nodes.values()].map(nodeView),
    programs: [...ledger.programs.values()].filter((p) => !p.retired).map(programView),
    execution: exec ? executionView(exec) : null,
    queue: ledger.queue
      .map((id) => ledger.executions.get(id))
      .filter((e) => e !== undefined)
      .map(queueEntry),
    machine,
  };
  // Page 0 must fit one frame whatever the programs carry (WP8.2): sixty-four programs with four
  // kilobytes of defaults each would not, so the defaults are the first thing to go — the editor
  // reads the manifest from the store anyway — and a subscribe degrades instead of closing.
  if (byteLength(canonicalStringify(cluster)) > SNAPSHOT_PAGE_BUDGET) {
    cluster.programs = cluster.programs.map((p) => ({ ...p, defaultParams: {} }));
  }
  // The page split is memoised per (generation, seq) (WP8.2): a connect-subscribe-close loop
  // used to re-serialise every task row per subscribe; now it costs one serialisation per change.
  const memo = ledger.session.pageMemo;
  let pages: TaskView[][];
  if (memo && memo.gen === ledger.meta.generation && memo.seq === ledger.meta.seq) {
    pages = memo.pages;
  } else {
    pages = [];
    let current: TaskView[] = [];
    let used = byteLength(canonicalStringify(cluster));
    for (const view of tasks) {
      const size = byteLength(canonicalStringify(view)) + 1;
      if (
        current.length > 0 &&
        (current.length >= LIMITS.snapshotPageTasks || used + size > SNAPSHOT_PAGE_BUDGET)
      ) {
        pages.push(current);
        current = [];
        used = 0;
      }
      current.push(view);
      used += size;
    }
    pages.push(current);
    ledger.session.pageMemo = { gen: ledger.meta.generation, seq: ledger.meta.seq, pages };
  }
  const effects: Effect[] = [];
  for (let page = 0; page < pages.length; page++) {
    const base: Snapshot = {
      t: "snapshot",
      v: PROTOCOL_VERSION,
      gen: ledger.meta.generation,
      seq: ledger.meta.seq,
      page,
      pages: pages.length,
      tasks: pages[page] ?? [],
      at: now,
    };
    effects.push({ kind: "send", connId, msg: page === 0 ? { ...base, ...cluster } : base });
  }
  return effects;
}

function onPing(ledger: Ledger, connId: string, now: number): Effect[] {
  const observer = ledger.observers.get(connId);
  if (!observer) return refuse(ledger, connId, CLOSE.invalidMessage, "ping before subscribe", now);
  observer.lastSeen = now;
  return [
    {
      kind: "send",
      connId,
      msg: { t: "pong", v: PROTOCOL_VERSION, gen: ledger.meta.generation, seq: ledger.meta.seq },
    },
  ];
}

/** Liveness: silent nodes are gone, silent observers are dropped, handshakes time out. */
export function sweep(ledger: Ledger, now: number): Effect[] {
  const effects: Effect[] = [];
  for (const node of [...ledger.nodes.values()]) {
    if (now - node.lastSeen > LIMITS.goneAfterMs) {
      effects.push({
        kind: "close",
        connId: node.connId,
        code: CLOSE.declaredGone,
        reason: "silent",
      });
      effects.push(...removeConnection(ledger, node.connId, "silent", now));
    }
  }
  for (const observer of [...ledger.observers.values()]) {
    if (now - observer.lastSeen > OBSERVER_SILENCE_MS) {
      effects.push({
        kind: "close",
        connId: observer.connId,
        code: CLOSE.declaredGone,
        reason: "silent",
      });
      effects.push(...removeConnection(ledger, observer.connId, "silent", now));
    }
  }
  for (const conn of [...ledger.conns.values()]) {
    const handshaken = ledger.nodeByConn.has(conn.connId) || ledger.observers.has(conn.connId);
    if (!handshaken && now - conn.openedAt > HANDSHAKE_TIMEOUT_MS) {
      effects.push({
        kind: "close",
        connId: conn.connId,
        code: CLOSE.invalidMessage,
        reason: "no hello",
      });
      ledger.conns.delete(conn.connId);
    }
  }
  return effects;
}

/** Close a connection with a reason code and forget everything about it. */
function refuse(
  ledger: Ledger,
  connId: string,
  code: number,
  reason: string,
  now: number,
): Effect[] {
  const effects: Effect[] = [{ kind: "close", connId, code, reason }];
  effects.push(...removeConnection(ledger, connId, "closed", now));
  return effects;
}

/** Forget a connection. A node's departure releases its work and is announced; an observer's is not. */
export function removeConnection(
  ledger: Ledger,
  connId: string,
  reason: "closed" | "silent",
  now: number,
): Effect[] {
  const effects: Effect[] = [];
  const nodeId = ledger.nodeByConn.get(connId);
  if (nodeId !== undefined) {
    const node = ledger.nodes.get(nodeId);
    ledger.nodes.delete(nodeId);
    ledger.nodeByConn.delete(connId);
    ledger.conns.delete(connId);
    unlinkCloudCore(ledger, nodeId, now);
    effects.push(...broadcast(ledger, { t: "nodeLeft", nodeId, reason }));
    if (node) effects.push(...releaseNode(ledger, node));
    return effects;
  }
  // The pause holder's socket went away: the machine resumes by itself (WP6.4).
  if (ledger.session.pausedBy === connId) effects.push(...resumeMachine(ledger, now));
  ledger.observers.delete(connId);
  ledger.conns.delete(connId);
  return effects;
}

/** Lift a pause, tell the observers, and let the machine pick up where it stopped. */
function resumeMachine(ledger: Ledger, now: number): Effect[] {
  if (ledger.session.pausedBy === null) return [];
  ledger.session.pausedBy = null;
  const effects = broadcast(ledger, { t: "controlApplied", op: "resume", nodeIds: [] });
  effects.push(...ensureDefaultLoop(ledger, now), ...maybeStart(ledger, now), ...fill(ledger, now));
  return effects;
}

function nodeOf(ledger: Ledger, connId: string): NodeRecord | undefined {
  const nodeId = ledger.nodeByConn.get(connId);
  return nodeId === undefined ? undefined : ledger.nodes.get(nodeId);
}

/**
 * The per-observer launch rate (design §5.5): a launch or a follow-up costs one token a minute.
 * Returns a message when the observer is over, null when it may proceed.
 */
function launchRateExceeded(ledger: Ledger, connId: string, now: number): string | null {
  const observer = ledger.observers.get(connId);
  if (!observer) return null;
  return chargeLaunch(observer, ledger.session, ledger.config.launchesPerMinute, now);
}
