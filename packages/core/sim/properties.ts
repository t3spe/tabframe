// The properties of design §6.10 and §6.8 as checks over the ledger, each event, and its effects:
// after every event, at the end of every frame, and at the end of the run. The fleet policy's
// bookkeeping (sleep transitions, launch gaps, cores adrift) lives here too.
import { canonicalStringify, type FsManifest, LIMITS } from "@tabframe/protocol";
import type { Effect, Event } from "../src/events.ts";
import { checkInvariants } from "../src/invariants.ts";
import type { ExecutionRecord, Ledger, TaskRecord } from "../src/ledger.ts";
import {
  CLOUD_CORE_LAUNCH_GAP_MS,
  DESIRED_CLOUD_CORES,
  SLEEP_AFTER_NO_INTERACTION_MS,
  SLEEP_AFTER_NO_OBSERVER_MS,
} from "../src/policy.ts";
import { wanted } from "../src/scheduler.ts";
import { adoptLedger, deserializeLedger, serializeLedger } from "../src/snapshot.ts";
import { stageTasks } from "../src/tasks.ts";
import type { LoadedProgram } from "./program.ts";
import type { FakeStore } from "./store.ts";
import { count, type SimStats } from "./types.ts";

const TILE_BYTES = 64 * 64 * 4;

/** What the checks need from the world. */
export interface PropertiesHost {
  readonly now: number;
  readonly stats: SimStats;
  readonly store: FakeStore;
  readonly program: LoadedProgram;
  readonly ledger: Ledger;
  readonly liars: number;
  violation(text: string): void;
  note(text: string): void;
  /** The golden indices a trimmed stage kept, if it was trimmed. */
  subsetFor(executionId: string, stage: number): number[] | undefined;
}

export class Properties {
  private readonly host: PropertiesHost;
  private readonly lies = new Set<string>();
  private readonly statuses = new Map<string, ExecutionRecord["status"]>();
  private readonly accepted = new Map<string, { identity: string; rounds: number }>();
  /** When each core record lost its node, for the adrift measurement. */
  private readonly adriftSince = new Map<string, number>();
  /** Awake/asleep bookkeeping, so an announcement can be counted against a transition. */
  private awake = true;
  private sleptAt: number | null = null;
  private announcementsThisSleep = 0;
  private lastLaunchAt: number | null = null;

  constructor(host: PropertiesHost) {
    this.host = host;
  }

  recordLie(hash: string): void {
    this.lies.add(hash);
  }

  /** Every event: the invariants, finality, slots, liveness, assignment tiers, painted tiles, the fleet policy. */
  afterEvent(event: Event, effects: Effect[]): void {
    const ledger = this.host.ledger;
    for (const v of checkInvariants(ledger)) this.host.violation(`invariant: ${v}`);

    // Finality (§6.10): an accepted result changes only through a mismatch.
    if (ledger.running) {
      for (const t of this.tasksOf(ledger.running)) {
        const prev = this.accepted.get(t.taskId);
        if (t.accepted) {
          if (prev && prev.identity !== t.accepted.identity && prev.rounds === t.contestedRounds)
            this.host.violation(`task ${t.taskId}: accepted result replaced without a mismatch`);
          this.accepted.set(t.taskId, { identity: t.accepted.identity, rounds: t.contestedRounds });
        } else if (prev) {
          if (prev.rounds === t.contestedRounds)
            this.host.violation(`task ${t.taskId}: accepted result withdrawn without a mismatch`);
          this.accepted.delete(t.taskId);
        }
      }
    }

    // Slots (§8.4) and ownership: two tasks per node at most, all of the running execution.
    for (const n of ledger.nodes.values()) {
      if (n.inFlight.length > LIMITS.maxInFlight)
        this.host.violation(`node ${n.nodeId} holds ${n.inFlight.length} tasks`);
      for (const id of n.inFlight) {
        const t = ledger.tasks.get(id);
        if (t && t.executionId !== ledger.running)
          this.host.violation(
            `node ${n.nodeId} holds ${id} of ${t.executionId}, which is not running`,
          );
      }
    }

    // Liveness (§6.4): a tick leaves nothing silent beyond the gone window.
    if (event.kind === "tick") {
      for (const n of ledger.nodes.values()) {
        if (this.host.now - n.lastSeen > LIMITS.goneAfterMs)
          this.host.violation(
            `node ${n.nodeId} silent for ${this.host.now - n.lastSeen} ms survived a tick`,
          );
      }
    }

    const painted = new Set<string>();
    let sleepingAnnouncements = 0;
    for (const e of effects) {
      if (e.kind !== "send") continue;
      if (e.msg.t === "assign") this.checkAssign(e.connId, e.msg.taskId, e.msg.attempt);
      // One broadcast reaches every observer; the announcement is the batch, not the message.
      else if (e.msg.t === "machineSleeping") sleepingAnnouncements = 1;
      else if (e.msg.t === "taskDone" && !painted.has(e.msg.taskId)) {
        painted.add(e.msg.taskId);
        this.checkPainted(e.msg.taskId, e.msg.output);
      }
    }
    this.fleetPolicy(sleepingAnnouncements);
  }

  /** Execution status changes since the last call: stats, and the frame checks for the ones that ended. */
  trackExecutions(): void {
    for (const exec of this.host.ledger.executions.values()) {
      const prev = this.statuses.get(exec.executionId);
      if (prev === exec.status) continue;
      this.statuses.set(exec.executionId, exec.status);
      switch (exec.status) {
        case "done":
          this.host.stats.framesDone += 1;
          this.host.note(`${exec.executionId} done`);
          this.checkFrame(exec);
          this.absorbCounters(exec);
          break;
        case "failed":
          this.host.stats.framesFailed += 1;
          count(this.host.stats.failures, exec.failure ?? "unknown");
          this.host.violation(`execution ${exec.executionId} failed: ${exec.failure}`);
          this.absorbCounters(exec);
          break;
        case "cancelled":
          this.host.stats.framesCancelled += 1;
          count(this.host.stats.failures, exec.failure ?? "cancelled");
          this.absorbCounters(exec);
          break;
        default:
          break;
      }
    }
  }

  /** The end of the run: the invariants once more, a snapshot round trip, and the liar accounting. */
  final(): void {
    const ledger = this.host.ledger;
    for (const v of checkInvariants(ledger)) this.host.violation(`final invariant: ${v}`);
    this.checkSnapshotRoundTrip();
    for (const e of ledger.executions.values()) {
      if (e.status === "running" || e.status === "queued") this.absorbCounters(e);
    }
    if (this.host.liars === 0 && this.host.stats.mismatched > 0)
      this.host.violation(`${this.host.stats.mismatched} mismatches without a liar around`);
  }

  private tasksOf(executionId: string): TaskRecord[] {
    const out: TaskRecord[] = [];
    for (const t of this.host.ledger.tasks.values()) if (t.executionId === executionId) out.push(t);
    return out;
  }

  private goldenFor(task: TaskRecord): string | null {
    const goldens = this.host.program.goldens;
    if (!goldens || task.kind !== "run" || task.stage !== 0) return null;
    const map = this.host.subsetFor(task.executionId, 0);
    const index = map ? map[task.index] : task.index;
    if (index === undefined) return null;
    return goldens.hashes[index] ?? null;
  }

  /** An assignment: to the right socket, of the running execution, in tier order (§6.3). */
  private checkAssign(connId: string, taskId: string, attemptNo: number): void {
    const ledger = this.host.ledger;
    const task = ledger.tasks.get(taskId);
    const attempt = task?.attempts.find((a) => a.attempt === attemptNo);
    if (!task || !attempt) {
      this.host.violation(`assign of unknown ${taskId}@${attemptNo}`);
      return;
    }
    const node = ledger.nodes.get(attempt.nodeId);
    if (!node || node.connId !== connId)
      this.host.violation(
        `assign ${taskId} went to ${connId}, its attempt is on ${attempt.nodeId}`,
      );
    if (task.executionId !== ledger.running)
      this.host.violation(`assign ${taskId} of ${task.executionId}, which is not running`);
    if (attempt.speculative) {
      const other = task.attempts.find((a) => a !== attempt && a.outcome === "running");
      if (!other)
        this.host.violation(`speculative twin of ${taskId} without a running first attempt`);
      else if (other.deadlineAt > this.host.now)
        this.host.violation(
          `speculative twin of ${taskId} opened ${other.deadlineAt - this.host.now} ms before the deadline`,
        );
      return;
    }
    if (task.released) return;
    // Released work outranks fresh work: nothing released that this node could take may wait.
    const exec = ledger.executions.get(task.executionId);
    if (!exec) return;
    for (const t of stageTasks(ledger, exec)) {
      if (t === task || !t.released || wanted(t) === 0) continue;
      if (t.attempts.some((a) => a.outcome === "running" && a.nodeId === attempt.nodeId)) continue;
      // A node that already reported on a contested task may leave it to nodes that have not.
      if (t.results.some((r) => r.nodeId === attempt.nodeId)) continue;
      this.host.violation(
        `fresh ${taskId} assigned to ${attempt.nodeId} while released ${t.taskId} waited`,
      );
      return;
    }
  }

  /** A painted tile is golden unless a liar painted it; liars are judged at the end of the frame. */
  private checkPainted(taskId: string, output: string): void {
    const task = this.host.ledger.tasks.get(taskId);
    if (!task) return;
    const golden = this.goldenFor(task);
    if (golden === null || output === golden || this.lies.has(output)) return;
    this.host.violation(
      `task ${taskId} painted ${output.slice(0, 12)}, the golden is ${golden.slice(0, 12)}`,
    );
  }

  /** A finished frame: every stage-0 output golden (or a voted-in lie), in the store, in the root. */
  private checkFrame(exec: ExecutionRecord): void {
    const id = exec.executionId;
    const goldens = this.host.program.goldens;
    const tasks = this.tasksOf(id)
      .filter((t) => t.kind === "run" && t.stage === 0)
      .sort((a, b) => a.index - b.index);
    const map = this.host.subsetFor(id, 0);
    const expected = map ? map.length : (goldens?.taskCount ?? tasks.length);
    if (tasks.length !== expected)
      this.host.violation(`${id}: ${tasks.length} stage-0 tasks, expected ${expected}`);
    for (const t of tasks) {
      if (t.status !== "done" || !t.accepted) {
        this.host.violation(`${id} is done while ${t.taskId} is ${t.status}`);
        continue;
      }
      const out = t.accepted;
      const golden = this.goldenFor(t);
      if (golden !== null && out.output !== golden) {
        if (!this.lies.has(out.output)) {
          this.host.violation(
            `${t.taskId}: accepted ${out.output.slice(0, 12)}, golden ${golden.slice(0, 12)}`,
          );
        } else {
          this.host.stats.liesAccepted += 1;
          if (t.requiredAgreement === 2 && !this.agreementExplains(t, golden))
            this.host.violation(
              `${t.taskId}: a lie accepted under redundancy without two nodes behind it (${describeResults(t, golden)})`,
            );
        }
      }
      if (out.outputSize !== TILE_BYTES)
        this.host.violation(`${t.taskId}: output size ${out.outputSize}`);
      if (!this.host.store.has(out.output))
        this.host.violation(`${t.taskId}: accepted output not in the store`);
      const entry = exec.files[`/out/0/${t.index}`];
      if (!entry || entry.hash !== out.output || entry.size !== out.outputSize)
        this.host.violation(`${t.taskId}: the manifest entry differs from the accepted result`);
    }
    if (!exec.root) {
      this.host.violation(`${id} done without a root`);
      return;
    }
    const bytes = this.host.store.get(exec.root);
    if (!bytes) {
      this.host.violation(`${id}: root ${exec.root.slice(0, 12)} is not in the store`);
      return;
    }
    const stored = JSON.parse(new TextDecoder().decode(bytes)) as FsManifest;
    const expectedManifest: FsManifest = { version: 1, files: exec.files };
    if (canonicalStringify(stored) !== canonicalStringify(expectedManifest))
      this.host.violation(`${id}: the stored root manifest differs from the ledger's files`);
  }

  /**
   * What the toggle promises (D7), counted the way the core counts it: a lie is accepted only when
   * two node ids reported it, or when a vote by node ids favoured it. A liar that reconnects is a
   * new node (D11) and may agree with its former self; that is the documented limit, not a bug.
   */
  private agreementExplains(task: TaskRecord, golden: string): boolean {
    const wrong = new Set<string>();
    const right = new Set<string>();
    for (const r of task.results) {
      if (r.identity === task.accepted?.identity) wrong.add(r.nodeId);
      else if (r.output === golden) right.add(r.nodeId);
    }
    return task.resolvedByVote ? wrong.size >= right.size : wrong.size >= 2;
  }

  /** Ended executions are pruned from the ledger after a while, so their counters are taken now. */
  private absorbCounters(exec: ExecutionRecord): void {
    const s = this.host.stats;
    s.done += exec.counters.done;
    s.reassigned += exec.counters.reassigned;
    s.speculated += exec.counters.speculated;
    s.verified += exec.counters.verified;
    s.mismatched += exec.counters.mismatched;
    for (const t of this.tasksOf(exec.executionId)) s.assigned += t.attempts.length;
  }

  /**
   * A handover in miniature (design §9.4): the ledger is serialized, read back, and adopted by the
   * next generation. The cloud cores must come across — their MicroVMs are still running out there
   * — with their node links cleared, because those sockets belonged to the generation that left.
   */
  private checkSnapshotRoundTrip(): void {
    const ledger = this.host.ledger;
    const before = [...ledger.cores.values()].map((c) => c.microvmId).sort();
    let next: Ledger;
    try {
      next = deserializeLedger(serializeLedger(ledger));
    } catch (err) {
      this.host.violation(`the ledger does not survive a snapshot: ${String(err)}`);
      return;
    }
    adoptLedger(next, ledger.meta.generation + 1, this.host.now);
    const after = [...next.cores.values()].map((c) => c.microvmId).sort();
    if (canonicalStringify(before) !== canonicalStringify(after))
      this.host.violation(
        `cores after a snapshot and adopt: ${after.join(",")}, before: ${before.join(",")}`,
      );
    for (const core of next.cores.values()) {
      if (core.nodeId !== null)
        this.host.violation(`adopted core ${core.microvmId} still links to node ${core.nodeId}`);
    }
    if (next.nodes.size !== 0) this.host.violation(`adopt left ${next.nodes.size} nodes behind`);
    for (const v of checkInvariants(next)) this.host.violation(`invariant after adopt: ${v}`);
  }

  /**
   * §6.8 as properties: never more cores than wanted, launches a second apart, no cores and no
   * automatic continuation while asleep, and one announcement per sleep.
   */
  private fleetPolicy(sleepingAnnouncements: number): void {
    const ledger = this.host.ledger;
    const now = this.host.now;
    const cores = ledger.cores;
    if (cores.size > DESIRED_CLOUD_CORES)
      this.host.violation(
        `the ledger holds ${cores.size} cores, the fleet wants ${DESIRED_CLOUD_CORES}`,
      );

    // A record with no node behind it is the machine short-handed. A few seconds of it is normal
    // (a MicroVM booting, a core reconnecting); a long one means the fleet is counting records
    // rather than working cores, which is measured here.
    for (const core of cores.values()) {
      if (core.nodeId !== null) {
        this.adriftSince.delete(core.microvmId);
        continue;
      }
      const since = this.adriftSince.get(core.microvmId) ?? now;
      this.adriftSince.set(core.microvmId, since);
      const ms = now - since;
      if (ms > this.host.stats.coresAdriftMs) this.host.stats.coresAdriftMs = ms;
    }
    for (const id of [...this.adriftSince.keys()]) if (!cores.has(id)) this.adriftSince.delete(id);

    if (!ledger.meta.awake) {
      if (cores.size > 0)
        this.host.violation(`asleep with ${cores.size} cores still in the ledger`);
      for (const exec of ledger.executions.values()) {
        if (!exec.human && this.sleptAt !== null && exec.queuedAt > this.sleptAt)
          this.host.violation(`${exec.executionId} was queued automatically while asleep`);
      }
    }

    // Awake ⇄ asleep, and the announcement that goes with it.
    if (this.awake && !ledger.meta.awake) {
      this.awake = false;
      this.sleptAt = now;
      this.announcementsThisSleep = 0;
      this.host.stats.sleeps += 1;
      const reason = ledger.meta.sleepReason ?? "";
      const quiet = now - ledger.meta.lastObserverAt;
      const idle = now - ledger.meta.lastInteractionAt;
      if (
        !(quiet >= SLEEP_AFTER_NO_OBSERVER_MS && ledger.observers.size === 0) &&
        !(idle >= SLEEP_AFTER_NO_INTERACTION_MS)
      ) {
        this.host.violation(`slept early: ${reason} after ${quiet} ms quiet, ${idle} ms idle`);
      }
      this.host.note(`machine asleep: ${reason}`);
    } else if (!this.awake && ledger.meta.awake) {
      this.awake = true;
      this.sleptAt = null;
      this.host.stats.wakes += 1;
      this.host.note("machine awake");
    }
    if (!this.awake) {
      this.announcementsThisSleep += sleepingAnnouncements;
      if (this.announcementsThisSleep > 1)
        this.host.violation(
          `${this.announcementsThisSleep} machineSleeping announcements for one sleep`,
        );
    } else if (sleepingAnnouncements > 0) {
      this.host.violation("machineSleeping announced while awake");
    }

    if (this.lastLaunchAt !== null && ledger.meta.lastCoreLaunchAt > this.lastLaunchAt) {
      const gap = ledger.meta.lastCoreLaunchAt - this.lastLaunchAt;
      if (gap < CLOUD_CORE_LAUNCH_GAP_MS)
        this.host.violation(
          `two core launches ${gap} ms apart, the gap is ${CLOUD_CORE_LAUNCH_GAP_MS}`,
        );
    }
    if (ledger.meta.lastCoreLaunchAt > 0) this.lastLaunchAt = ledger.meta.lastCoreLaunchAt;
  }
}

/** The reports of a task, for a violation message: node, round, and whether it was the golden. */
function describeResults(task: TaskRecord, golden: string): string {
  const reports = task.results
    .map((r) => `${r.nodeId}@r${r.round}:${r.output === golden ? "golden" : r.output.slice(0, 6)}`)
    .join(" ");
  return `rounds ${task.contestedRounds}, vote ${task.resolvedByVote}, accepted ${task.accepted?.output.slice(0, 6) ?? "-"}, reports ${reports}`;
}
