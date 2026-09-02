import { describe, expect, test } from "bun:test";
import { ensureDefaultLoop } from "./executions.ts";
import {
  CORE_LAUNCH_GAP_MS,
  CORE_MAX_AGE_MS,
  coreGone,
  coreLaunched,
  DESIRED_CORES,
  microvmIdOfHost,
  SLEEP_AFTER_NO_INTERACTION_MS,
  SLEEP_AFTER_NO_OBSERVER_MS,
  sleepReason,
} from "./fleet.ts";
import { BUNDLE, harness } from "./harness.ts";

const cloud = () => harness({ cloudCores: true });
const kinds = (effects: Array<{ kind: string }>) => effects.map((e) => e.kind);

describe("the cloud-core fleet", () => {
  test("keeps two cores while awake, one launch a second, and records them in the ledger", () => {
    const h = cloud();
    h.subscribe("obs");
    // The first tick asks for one core; the second is refused until a second has passed.
    expect(kinds(h.tick())).toContain("launchCore");
    expect(kinds(h.tick())).not.toContain("launchCore");
    h.event({ kind: "coreLaunched", microvmId: "microvm-a" });
    h.advance(CORE_LAUNCH_GAP_MS);
    expect(kinds(h.tick())).toContain("launchCore");
    h.event({ kind: "coreLaunched", microvmId: "microvm-b" });
    expect(h.ledger.cores.size).toBe(DESIRED_CORES);
    // Two is enough, however long passes.
    h.advance(60_000);
    expect(kinds(h.tick())).not.toContain("launchCore");
  });

  test("a core that says hello is linked to its node, and unlinked when it goes", () => {
    const h = cloud();
    h.subscribe("obs");
    h.event({ kind: "coreLaunched", microvmId: "microvm-a" });
    h.hello("c1", "core-microvm-a", "core");
    const core = h.ledger.cores.get("microvm-a");
    expect(core?.nodeId).toBe("n1");
    expect(h.ledger.nodes.get("n1")?.kind).toBe("core");
    h.disconnect("c1");
    expect(h.ledger.cores.get("microvm-a")?.nodeId).toBeNull();
    // The core itself is still there: the MicroVM is alive, it will reconnect.
    expect(h.ledger.cores.size).toBe(1);
  });

  test("the ledger's core links are an invariant: a link always names that core's own node", () => {
    const h = cloud();
    h.subscribe("obs");
    h.event({ kind: "coreLaunched", microvmId: "microvm-a" });
    h.hello("c1", "core-microvm-a", "core");
    expect(h.invariants()).toEqual([]);
    // A link to a node that has gone, or to a node of another host, is a violation.
    const core = h.ledger.cores.get("microvm-a");
    if (!core) throw new Error("no core");
    core.nodeId = "n404";
    expect(h.invariants()).toEqual(["core microvm-a links to gone node n404"]);
    h.hello("c2", "h-tab", "tab");
    core.nodeId = "n2";
    expect(h.invariants()).toEqual(["core microvm-a links to n2, whose host is h-tab"]);
  });

  test("a core whose MicroVM is gone is replaced", () => {
    const h = cloud();
    h.subscribe("obs");
    h.event({ kind: "coreLaunched", microvmId: "microvm-a" });
    h.event({ kind: "coreLaunched", microvmId: "microvm-b" });
    h.advance(CORE_LAUNCH_GAP_MS);
    expect(kinds(h.tick())).not.toContain("launchCore");
    h.event({ kind: "coreGone", microvmId: "microvm-a" });
    h.advance(CORE_LAUNCH_GAP_MS);
    expect(kinds(h.tick())).toContain("launchCore");
  });

  test("a core near its ceiling is retired and replaced", () => {
    const h = cloud();
    h.subscribe("obs");
    h.event({ kind: "coreLaunched", microvmId: "microvm-a" });
    h.event({ kind: "coreLaunched", microvmId: "microvm-b" });
    h.advance(CORE_MAX_AGE_MS);
    // Someone is still watching and still clicking, so the machine is awake at the ceiling.
    h.subscribe("obs2");
    h.ledger.meta.lastInteractionAt = h.now;
    const effects = h.tick();
    expect(effects).toContainEqual({ kind: "terminateCore", microvmId: "microvm-a" });
    expect(effects).toContainEqual({ kind: "terminateCore", microvmId: "microvm-b" });
    expect(h.ledger.cores.size).toBe(0);
    expect(kinds(effects)).toContain("launchCore");
  });

  test("a control plane without the MicroVM API launches nothing", () => {
    const h = harness(); // cloudCores defaults off: a laptop
    h.subscribe("obs");
    h.advance(10_000);
    expect(kinds(h.tick())).not.toContain("launchCore");
  });

  test("a host id names a MicroVM only when it is a cloud core", () => {
    expect(microvmIdOfHost("core-microvm-1a2b")).toBe("microvm-1a2b");
    expect(microvmIdOfHost("core-laptop-123")).toBeNull();
    expect(microvmIdOfHost("tab-9f")).toBeNull();
  });
});

describe("the sleep policy", () => {
  test("ten minutes with nobody watching puts the machine to sleep and kills the cores", () => {
    const h = cloud();
    h.subscribe("obs");
    h.event({ kind: "coreLaunched", microvmId: "microvm-a" });
    h.disconnect("obs");
    h.advance(SLEEP_AFTER_NO_OBSERVER_MS - 1);
    expect(kinds(h.tick())).not.toContain("terminateCore");
    expect(h.ledger.meta.awake).toBe(true);
    h.advance(1);
    const effects = h.tick();
    expect(effects).toContainEqual({ kind: "terminateCore", microvmId: "microvm-a" });
    expect(h.ledger.meta.awake).toBe(false);
    expect(h.ledger.meta.sleepReason).toContain("nobody watching");
    expect(h.ledger.cores.size).toBe(0);
    // Said once, not on every tick.
    const again = h.tick();
    expect(again.some((e) => e.kind === "send")).toBe(false);
  });

  test("an hour without interaction sleeps even with a dashboard open, and a control wakes it", () => {
    const h = cloud();
    h.subscribe("obs");
    h.advance(SLEEP_AFTER_NO_INTERACTION_MS);
    h.send("obs", { t: "ping" }); // pings keep the socket, not the machine, alive
    const effects = h.tick();
    expect(h.ledger.meta.awake).toBe(false);
    expect(h.ledger.meta.sleepReason).toContain("touching the dashboard");
    expect(effects.some((e) => e.kind === "send" && e.msg.t === "machineSleeping")).toBe(true);
    // A real control is an interaction: the machine wakes and the fleet comes back.
    h.send("obs", { t: "resumeAll" });
    expect(kinds(h.tick())).toContain("launchCore");
    expect(h.ledger.meta.awake).toBe(true);
    expect(h.ledger.meta.sleepReason).toBeNull();
  });

  test("the default loop pauses while the machine is asleep, though a tab is open", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    expect(h.ledger.running).not.toBeNull();
    h.ledger.running = null; // the frame ended
    h.ledger.meta.awake = false;
    expect(ensureDefaultLoop(h.ledger, h.now)).toEqual([]);
    h.ledger.meta.awake = true;
    expect(
      ensureDefaultLoop(h.ledger, h.now).some(
        (e) => e.kind === "send" && e.msg.t === "executionQueued",
      ),
    ).toBe(true);
  });

  test("waking is what a visitor or a control does; the fleet comes back with it", () => {
    const h = cloud();
    h.subscribe("obs");
    h.advance(SLEEP_AFTER_NO_INTERACTION_MS);
    h.tick();
    expect(h.ledger.meta.awake).toBe(false);
    // A fresh visitor is an interaction: awake, and the cores are asked for again.
    h.subscribe("obs2");
    expect(kinds(h.tick())).toContain("launchCore");
    expect(h.ledger.meta.awake).toBe(true);
    expect(h.ledger.meta.sleepReason).toBeNull();
  });

  test("sleepReason is null while someone is watching and touching things", () => {
    const h = cloud();
    h.subscribe("obs");
    expect(sleepReason(h.ledger, h.now)).toBeNull();
    h.advance(SLEEP_AFTER_NO_INTERACTION_MS - 1);
    expect(sleepReason(h.ledger, h.now)).toBeNull();
  });

  test("cores survive a snapshot and are inherited, with their node links cleared", async () => {
    const { adoptLedger, deserializeLedger, serializeLedger } = await import("./snapshot.ts");
    const h = cloud();
    h.subscribe("obs");
    h.event({ kind: "coreLaunched", microvmId: "microvm-a" });
    h.hello("c1", "core-microvm-a", "core");
    const next = deserializeLedger(serializeLedger(h.ledger));
    expect(next.cores.get("microvm-a")?.nodeId).toBe("n1");
    adoptLedger(next, h.ledger.meta.generation + 1, h.now);
    expect(next.cores.size).toBe(1);
    expect(next.cores.get("microvm-a")?.nodeId).toBeNull();
    expect(next.nodes.size).toBe(0);
  });

  test("coreLaunched is idempotent and coreGone forgets", () => {
    const h = cloud();
    coreLaunched(h.ledger, "microvm-a", 1);
    coreLaunched(h.ledger, "microvm-a", 2);
    expect(h.ledger.cores.size).toBe(1);
    expect(h.ledger.cores.get("microvm-a")?.launchedAt).toBe(1);
    coreGone(h.ledger, "microvm-a");
    expect(h.ledger.cores.size).toBe(0);
  });
});
