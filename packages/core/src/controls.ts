// What an observer says on its socket (design §6.7, §8.3): subscribe, ping, presign, and the
// controls a person or the demo drives the machine with.
import {
  CLOSE,
  type Control,
  LIMITS,
  type ObserverToControlPlane,
  PROTOCOL_VERSION,
} from "@tabframe/protocol";
import { advance, resumeMachine } from "./advance.ts";
import { chargeLaunch, chargePresign, coolingDown } from "./budgets.ts";
import { presignReply, refuse } from "./connections.ts";
import type { Effect } from "./events.ts";
import { afterTaskSettled, cancelExecution, enqueue, runningExecution } from "./execution.ts";
import { forgetCloudCore } from "./fleet.ts";
import type { ConnState, LaunchRequest, Ledger, NodeRecord } from "./ledger.ts";
import { broadcast, errorMsg } from "./observers.ts";
import { snapshotPages } from "./pages.ts";
import { CONTROL_COOLDOWN_MS } from "./policy.ts";
import { settleExisting } from "./results.ts";

/**
 * Controls that end work or command nodes, applied at most once per cooldown machine-wide: each
 * ends every task of an execution at once, and at five messages a second one socket could end
 * every execution as it started. The redundancy flip stays out: a person who toggles it and back
 * within two seconds must get the second flip, or the checkbox shows a state the machine did not
 * take.
 */
const DESTRUCTIVE = new Set([
  "killHalf",
  "freezeHalf",
  "throttleHalf",
  "restart",
  "stop",
  "skip",
  "killExecution",
]);

/** A decoded, rate-gated observer message. */
export function onObserverMessage(
  ledger: Ledger,
  connId: string,
  conn: ConnState,
  msg: ObserverToControlPlane,
  now: number,
  rng: () => number,
): Effect[] {
  switch (msg.t) {
    case "subscribe":
      return onSubscribe(ledger, connId, now);
    case "ping":
      return onPing(ledger, connId, now);
    case "presign": {
      if (!ledger.observers.has(connId))
        return refuse(ledger, connId, CLOSE.invalidMessage, "presign before subscribe", now);
      const charged = chargePresign(conn, ledger.session, msg.items, now);
      return presignReply(ledger, connId, "observer", charged, msg.items, now);
    }
    default:
      if (!ledger.observers.has(connId))
        return refuse(ledger, connId, CLOSE.invalidMessage, "control before subscribe", now);
      ledger.meta.lastInteractionAt = now;
      return onControl(ledger, connId, msg, now, rng);
  }
}

function onSubscribe(ledger: Ledger, connId: string, now: number): Effect[] {
  if (ledger.observers.has(connId))
    return refuse(ledger, connId, CLOSE.invalidMessage, "duplicate subscribe", now);
  if (ledger.observers.size >= LIMITS.observerCap)
    return refuse(ledger, connId, CLOSE.observerCap, "observer cap reached", now);
  ledger.observers.set(connId, { connId, subscribedAt: now, lastSeen: now, launchedAt: [] });
  ledger.meta.lastInteractionAt = now;
  const effects = snapshotPages(ledger, connId, now);
  effects.push(...advance(ledger, now));
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

/** Queue a launch; a refusal is told to the observer that asked, if one did. */
export function launchFor(
  ledger: Ledger,
  req: LaunchRequest,
  connId: string | undefined,
  now: number,
): Effect[] {
  const r = enqueue(ledger, req, now);
  if (r.error)
    return connId
      ? [{ kind: "send", connId, msg: errorMsg(ledger, "launch-refused", r.error) }]
      : [];
  return [...r.effects, ...advance(ledger, now)];
}

function onControl(
  ledger: Ledger,
  connId: string,
  msg: Control,
  now: number,
  rng: () => number,
): Effect[] {
  const running = runningExecution(ledger);
  // Ending the running execution is destructive; dropping a queued one is not: a person who kills
  // a frame and then tidies the queue must not be told to wait two seconds.
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
      // The relaunch goes to the front of whatever is still queued.
      if (relaunch.executionId && ledger.queue.includes(relaunch.executionId)) {
        ledger.queue = [
          relaunch.executionId,
          ...ledger.queue.filter((id) => id !== relaunch.executionId),
        ];
      }
      effects.push(...relaunch.effects, ...advance(ledger, now));
      return effects;
    }
    case "skip": {
      if (!running) return [];
      const effects = cancelExecution(ledger, running, "skipped", now);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "skip", nodeIds: [] }));
      effects.push(...advance(ledger, now));
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
      effects.push(...advance(ledger, now));
      return effects;
    }
    case "launch": {
      const limited = launchRefusal(ledger, connId, now);
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
      return launchFor(
        ledger,
        { bundle: msg.bundle, params: msg.params, human: true, inherit: msg.inherit },
        connId,
        now,
      );
    }
    case "runFollowUp": {
      const limited = launchRefusal(ledger, connId, now);
      if (limited)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "rate-limited", limited) }];
      const done = ledger.executions.get(msg.executionId);
      if (done?.status !== "done" || !done.followUp)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "no-follow-up", msg.executionId) }];
      return launchFor(
        ledger,
        { bundle: done.bundle, params: done.followUp, human: true, inherit: done.executionId },
        connId,
        now,
      );
    }
    case "setRedundancy": {
      ledger.meta.redundancy = msg.on;
      const effects = broadcast(ledger, { t: "controlApplied", op: "setRedundancy", nodeIds: [] });
      if (!msg.on) {
        // The toggle going off reaches open tasks too: one result is enough now, and a task that
        // already holds one settles on it, so a lone node is not left waiting for a twin.
        for (const task of ledger.tasks.values()) {
          if (task.status === "done" || task.status === "failed") continue;
          task.requiredAgreement = 1;
          const { effects: settled, settlement } = settleExisting(ledger, task, now);
          effects.push(...settled);
          if (settlement.kind === "done" || settlement.kind === "failed")
            effects.push(...afterTaskSettled(ledger, settlement.task, now));
        }
        effects.push(...advance(ledger, now));
      }
      return effects;
    }
    case "stop": {
      // A person wants the machine idle: the running execution ends, the loop's queued
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
      effects.push(...advance(ledger, now));
      return effects;
    }
    case "pause": {
      // The editor tab that asked holds the pause; nothing new is assigned or started until it
      // resumes or goes away. Asking twice from the same socket is one pause.
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
      effects.push(...advance(ledger, now));
      return effects;
    }
  }
}

/** Why this observer may not launch right now (design §5.5), or null once the launch is counted. */
function launchRefusal(ledger: Ledger, connId: string, now: number): string | null {
  const observer = ledger.observers.get(connId);
  if (!observer) return null;
  return chargeLaunch(observer, ledger.session, ledger.config.launchesPerMinute, now);
}

/** Demo controls (design §6.7): pick victims across the whole cluster and command them. */
export function commandHalf(
  ledger: Ledger,
  op: "close" | "freeze" | "throttle",
  rng: () => number,
): { effects: Effect[]; victims: string[] } {
  const nodes = [...ledger.nodes.values()];
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = nodes[i] as NodeRecord;
    nodes[i] = nodes[j] as NodeRecord;
    nodes[j] = a;
  }
  const victims = nodes.slice(0, Math.ceil(nodes.length / 2));
  const effects: Effect[] = [];
  for (const v of victims) {
    // Freeze is terminal (design §4, §6.7): a frozen worker computes nothing and is declared gone
    // within the silence window. Downgrading its record to `throttle` would make `fill` hand it
    // work it can never do, so a later throttle leaves a frozen node frozen.
    if (op === "throttle" && v.commanded !== "freeze") v.commanded = "throttle";
    if (op === "freeze") v.commanded = "freeze";
    effects.push({
      kind: "send",
      connId: v.connId,
      msg: { t: "command", v: PROTOCOL_VERSION, gen: ledger.meta.generation, op },
    });
    // A killed or frozen cloud core is a MicroVM with nothing left to do: a closed node never
    // reconnects and a frozen one computes nothing, so the VM goes with the command and the fleet
    // policy launches a fresh one (design §6.8).
    if (op !== "throttle" && v.kind === "core") {
      for (const core of [...ledger.cores.values()]) {
        if (core.nodeId === v.nodeId) effects.push(forgetCloudCore(ledger, core.microvmId));
      }
    }
  }
  return { effects, victims: victims.map((v) => v.nodeId) };
}

/** Undo `throttleHalf`; a frozen node is left for the sweep. */
export function resumeAll(ledger: Ledger): { effects: Effect[]; victims: string[] } {
  const effects: Effect[] = [];
  const victims: string[] = [];
  for (const n of ledger.nodes.values()) {
    if (n.commanded !== "throttle") continue;
    n.commanded = null;
    victims.push(n.nodeId);
    effects.push({
      kind: "send",
      connId: n.connId,
      msg: { t: "command", v: PROTOCOL_VERSION, gen: ledger.meta.generation, op: "resume" },
    });
  }
  return { effects, victims };
}
