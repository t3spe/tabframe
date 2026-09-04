import { describe, expect, test } from "bun:test";
import { encode, LIMITS } from "@tabframe/protocol";
import { H, harness } from "./harness.ts";

// Loop 2 (WP8.2): page 0 of a snapshot must fit one frame whatever the programs carry.
describe("snapshot page 0 under heavy programs", () => {
  test("sixty-four programs with four kilobytes of defaults each still subscribe, with the defaults stripped", () => {
    const h = harness();
    h.hello("a", "h1");
    const heavy = { blob: "x".repeat(3_900) };
    for (let i = 0; i < 64; i++) {
      const c = (i + 10).toString(36).padStart(2, "0");
      h.event({
        kind: "programAdded",
        bundle: H(c[0] ?? "a").slice(0, 62) + c,
        module: H("d"),
        manifest: { name: `p${i}`, view: "tiles", persist: false, defaultParams: heavy },
        files: {},
      });
    }
    const effects = h.subscribe("obs");
    const pages = effects.filter((e) => e.kind === "send" && e.msg.t === "snapshot");
    expect(pages.length).toBeGreaterThan(0);
    for (const e of pages) {
      if (e.kind !== "send") continue;
      // encode() throws over the cap; nothing here does.
      expect(new TextEncoder().encode(encode(e.msg)).length).toBeLessThanOrEqual(
        LIMITS.maxMessageBytes,
      );
    }
    const first = pages[0];
    if (first?.kind === "send" && first.msg.t === "snapshot" && "programs" in first.msg) {
      const programs = first.msg.programs as Array<{ defaultParams: Record<string, unknown> }>;
      expect(programs.length).toBe(64);
      expect(programs.every((p) => Object.keys(p.defaultParams).length === 0)).toBe(true);
    } else {
      throw new Error("page 0 carries the cluster");
    }
    // A light ledger keeps its defaults.
    const light = harness();
    light.hello("a", "h1");
    light.event({
      kind: "programAdded",
      bundle: H("e"),
      module: H("d"),
      manifest: { name: "light", view: "tiles", persist: false, defaultParams: { preset: 1 } },
      files: {},
    });
    const page0 = light.subscribe("obs").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (page0?.kind === "send" && page0.msg.t === "snapshot" && "programs" in page0.msg) {
      const programs = page0.msg.programs as Array<{ defaultParams: Record<string, unknown> }>;
      expect(programs.some((p) => p.defaultParams.preset === 1)).toBe(true);
    }
  });
});
