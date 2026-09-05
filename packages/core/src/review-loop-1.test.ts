// The first review loop's core rules (WP8.1): a pending store effect is re-derived after an adopt
// and again when the store stays silent; params and the queue are bounded; destructive controls
// have a cooldown; presigns have a byte budget; a control plane that handed over acts on nothing
// until its lease runs out; turning redundancy off settles tasks that already hold a result.
import { describe, expect, test } from "bun:test";
import { LIMITS } from "@tabframe/protocol";
import { beginHandover } from "./handover.ts";
import { BUNDLE, H, harness, renderSpec } from "./harness.ts";
import {
  CONTROL_COOLDOWN_MS,
  HANDOVER_LEASE_MS,
  PARAMS_MAX_BYTES,
  PRESIGN_BYTES_PER_MIN,
  QUEUE_CAP,
  STORE_RETRY_MS,
} from "./policy.ts";
import { adoptLedger, deserializeLedger, serializeLedger } from "./snapshot.ts";

const kinds = (fx: ReturnType<ReturnType<typeof harness>["tick"]>) => fx.map((e) => e.kind);

/** A machine with one node and a person's launch whose plan task is done: the spec fetch is pending. */
function withPlanDone() {
  const h = harness();
  h.addProgram();
  h.subscribe("o1");
  h.hello("c1", "h1");
  const launched = h.launch({ preset: 1 }, true);
  const [plan] = h.assigns(launched);
  if (!plan) throw new Error("no plan assign");
  const planned = h.result(plan.connId, plan.taskId, plan.attempt, H("a"));
  return { h, planned, plan };
}

describe("a pending store effect is re-derived (WP8.1)", () => {
  test("the stage spec fetch is issued again after an adopt, and again when the store stays silent", () => {
    const { h, planned } = withPlanDone();
    expect(planned.some((e) => e.kind === "fetchBlob" && e.purpose.type === "stageSpec")).toBe(
      true,
    );
    // The predecessor issued the fetch and died with it: the successor adopts and asks again.
    const adopted = deserializeLedger(serializeLedger(h.ledger));
    const effects = adoptLedger(adopted, adopted.meta.generation + 1, h.now + 1_000);
    expect(effects.some((e) => e.kind === "fetchBlob" && e.purpose.type === "stageSpec")).toBe(
      true,
    );
    // Silence from the store: the same fetch again after the retry interval, not before.
    expect(kinds(h.tick())).not.toContain("fetchBlob");
    h.advance(STORE_RETRY_MS + 1);
    expect(h.tick().some((e) => e.kind === "fetchBlob" && e.purpose.type === "stageSpec")).toBe(
      true,
    );
  });

  test("the folded manifest is put again after an adopt; the answer advances the stage once", () => {
    const { h, planned } = withPlanDone();
    const spec = h.planSpec(planned, renderSpec(1));
    let fold: ReturnType<typeof h.result> = [];
    for (const a of h.assigns(spec))
      fold = [...fold, ...h.result(a.connId, a.taskId, a.attempt, H("d"))];
    const put = fold.find((e) => e.kind === "putBlob");
    if (put?.kind !== "putBlob" || put.purpose.type !== "manifest") throw new Error("no fold");
    const adopted = deserializeLedger(serializeLedger(h.ledger));
    const effects = adoptLedger(adopted, adopted.meta.generation + 1, h.now + 1_000);
    const again = effects.find((e) => e.kind === "putBlob");
    if (again?.kind !== "putBlob" || again.purpose.type !== "manifest")
      throw new Error("no re-put");
    expect(again.purpose.stage).toBe(put.purpose.stage);
    expect(Buffer.from(again.bytes).equals(Buffer.from(put.bytes))).toBe(true); // content-addressed: the same manifest
  });

  test("an inherited root is fetched again; an origin that was pruned falls back to the bundle with a warning", () => {
    const h = harness({ defaultLoop: null });
    h.addProgram();
    h.subscribe("o1");
    h.hello("c1", "h1");
    // Finish one run so there is something to inherit.
    const first = h.launch({ preset: 1 }, true);
    const [plan] = h.assigns(first);
    if (!plan) throw new Error("no plan");
    const spec = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("a")),
      renderSpec(1),
    );
    let fold: ReturnType<typeof h.result> = [];
    for (const a of h.assigns(spec))
      fold = [...fold, ...h.result(a.connId, a.taskId, a.attempt, H("d"))];
    const stored = h.manifestStored(fold);
    const [plan2] = h.assigns(stored);
    if (!plan2) throw new Error("no second plan");
    h.planSpec(h.result(plan2.connId, plan2.taskId, plan2.attempt, H("c")), {
      kind: "done",
      next: null,
    });
    expect(h.ledger.executions.get("e1")?.status).toBe("done");
    const second = h.event({
      kind: "launch",
      bundle: BUNDLE,
      params: { preset: 2 },
      human: true,
      inherit: "e1",
    });
    expect(second.some((e) => e.kind === "fetchBlob" && e.purpose.type === "inheritRoot")).toBe(
      true,
    );
    h.advance(STORE_RETRY_MS + 1);
    expect(h.tick().some((e) => e.kind === "fetchBlob" && e.purpose.type === "inheritRoot")).toBe(
      true,
    );
  });
});

describe("bounds (WP8.1)", () => {
  test("params over the cap and a full queue are refused with a reason", () => {
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    const big = { text: "x".repeat(PARAMS_MAX_BYTES) };
    const refused = h.send("o1", { t: "launch", bundle: BUNDLE, params: big, inherit: null });
    expect(
      refused.some(
        (e) => e.kind === "send" && e.msg.t === "error" && /params over/.test(e.msg.message),
      ),
    ).toBe(true);
    for (let i = 0; i < QUEUE_CAP + 2; i++) h.launch({ i }, true);
    expect(h.ledger.queue.length).toBeLessThanOrEqual(QUEUE_CAP);
  });

  test("a destructive control is refused within the cooldown, machine-wide", () => {
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    h.subscribe("o2");
    h.hello("c1", "h1");
    h.hello("c2", "h2");
    expect(
      h
        .send("o1", { t: "freezeHalf" })
        .some((e) => e.kind === "send" && e.msg.t === "controlApplied"),
    ).toBe(true);
    const again = h.send("o2", { t: "freezeHalf" });
    expect(
      again.some((e) => e.kind === "send" && e.msg.t === "error" && e.msg.code === "cooldown"),
    ).toBe(true);
    h.advance(CONTROL_COOLDOWN_MS + 1);
    expect(
      h
        .send("o2", { t: "resumeAll" })
        .some((e) => e.kind === "send" && e.msg.t === "controlApplied"),
    ).toBe(true);
  });

  test("a connection's presigned bytes are a refilling budget (WP8.2)", () => {
    const h = harness();
    h.hello("c1", "h1");
    const hash = "b".repeat(64);
    // Each item is at the protocol's cap; the minute's budget runs out after a bounded number of
    // them, and comes back with the next minute — so an honest core rendering all day is never closed.
    const perItem = LIMITS.maxOutputBytes;
    const allowed = Math.floor(PRESIGN_BYTES_PER_MIN / perItem);
    let closedAt = -1;
    for (let i = 0; i < allowed + 2 && closedAt < 0; i++) {
      const fx = h.send("c1", { t: "presign", items: [{ hash, size: perItem }] });
      if (fx.some((e) => e.kind === "close")) closedAt = i;
      else expect(fx.some((e) => e.kind === "presign")).toBe(true);
    }
    expect(closedAt).toBe(allowed);
    h.hello("c2", "h2");
    for (let i = 0; i < allowed; i++) {
      expect(
        h
          .send("c2", { t: "presign", items: [{ hash, size: perItem }] })
          .some((e) => e.kind === "presign"),
      ).toBe(true);
    }
    h.advance(60_000);
    expect(
      h
        .send("c2", { t: "presign", items: [{ hash, size: perItem }] })
        .some((e) => e.kind === "presign"),
    ).toBe(true);
  });
});

describe("a control plane that handed over (WP8.1)", () => {
  test("acts on nothing until drained, and comes back when the lease runs out", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("o1");
    h.hello("c1", "h1");
    h.addProgram("tiles");
    expect(h.ledger.running).toBe("e1");
    beginHandover(h.ledger, h.now);
    expect(h.ledger.meta.phase).toBe("handing-over");
    h.advance(1_000);
    const quiet = h.tick();
    expect(quiet.filter((e) => e.kind === "send" || e.kind === "launchCore")).toEqual([]);
    h.advance(HANDOVER_LEASE_MS + 1);
    h.tick();
    expect(h.ledger.meta.phase).toBe("active");
  });
});

describe("redundancy off (WP8.1)", () => {
  test("open tasks need one result, and one that already holds a result settles on it", () => {
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    h.send("o1", { t: "setRedundancy", on: true });
    h.hello("c1", "h1");
    const launched = h.launch({ preset: 1 }, true);
    const plans = h.assigns(launched);
    expect(plans.length).toBe(1); // one node: the twin waits
    const [plan] = plans;
    if (!plan) throw new Error("no plan");
    h.result(plan.connId, plan.taskId, plan.attempt, H("a"));
    expect(h.ledger.tasks.get(plan.taskId)?.status).not.toBe("done"); // waiting for a twin that never comes
    h.advance(2_000); // the redundancy flip is a destructive control since WP8.3: one per two seconds
    const off = h.send("o1", { t: "setRedundancy", on: false });
    expect(h.ledger.tasks.get(plan.taskId)?.status).toBe("done");
    expect(off.some((e) => e.kind === "fetchBlob" && e.purpose.type === "stageSpec")).toBe(true);
  });
});
