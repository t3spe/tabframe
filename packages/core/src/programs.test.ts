import { describe, expect, test } from "bun:test";
import { BUNDLE, harness } from "./harness.ts";

/** A late observer learns the programs from the snapshot, not only from programAdded. */
describe("programs in the snapshot", () => {
  test("page 0 lists every program with its view and default params", () => {
    const h = harness();
    h.addProgram("bars");
    const effects = h.subscribe("obs");
    const snap = effects.find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (!snap || snap.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.programs).toEqual([
      {
        bundle: BUNDLE,
        name: "demo",
        view: "bars",
        description: null,
        defaultParams: { preset: 0 },
        addedAt: expect.any(Number),
      },
    ]);
  });
});
