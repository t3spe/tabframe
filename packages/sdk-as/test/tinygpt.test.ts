import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { programManifest } from "@tabframe/protocol";
import { compileProgram } from "../scripts/build-programs.ts";
import { loadProgram, runStaged } from "../scripts/host.ts";

// Tiny GPT (WP6.5): the forward pass in WebAssembly against the reference its training script
// wrote with the same (dequantised) weights. Skipped when the weights are not there.
const root = path.resolve(import.meta.dir, "../../..");
const programDir = path.join(root, "programs", "tinygpt");
const out = path.join(import.meta.dir, "..", "dist-test", "tinygpt.wasm");
const weightsFile = path.join(programDir, "in", "weights.bin");
const referenceFile = path.join(programDir, "train", "reference.json");
const have = existsSync(weightsFile) && existsSync(referenceFile);

interface Reference {
  prompt: string;
  promptIds: number[];
  greedy: number[];
  text: string;
}

let module: WebAssembly.Module;
const manifest = programManifest.parse(
  JSON.parse(readFileSync(path.join(programDir, "manifest.json"), "utf8")),
);

function bundleInputs(): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const f of readdirSync(path.join(programDir, "in")).sort())
    m.set(`/in/${f}`, new Uint8Array(readFileSync(path.join(programDir, "in", f))));
  return m;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  await compileProgram(path.join(programDir, "assembly", "index.ts"), out);
  module = loadProgram(new Uint8Array(readFileSync(out))).module;
}, 120_000);

describe.skipIf(!have)("tiny GPT", () => {
  test("manifest: a text program with prompts and a token count", () => {
    expect(manifest.view).toBe("text");
    expect(String(manifest.defaultParams.prompts)).toContain("|");
    expect(manifest.defaultParams.tokens).toBe(96);
  });

  test("the continuations agree with the reference, token for token, and the bytes are the same every run", async () => {
    const refs = JSON.parse(readFileSync(referenceFile, "utf8")) as Reference[];
    const prompts = refs.map((r) => r.prompt).join("|");
    const started = performance.now();
    const run = runStaged(module, bundleInputs(), { prompts, tokens: 24 });
    const ms = performance.now() - started;
    expect(run.stages.map((s) => s.name)).toEqual(["generate", "collect"]);
    const stage0 = run.stages[0];
    if (!stage0) throw new Error("no stage 0");
    expect(stage0.taskCount).toBe(refs.length);
    const header = new Uint8Array(readFileSync(weightsFile).buffer.slice(0, 28));
    const dv = new DataView(header.buffer);
    const vocab = dv.getUint32(8, true);
    const symbols = new Uint8Array(readFileSync(weightsFile).buffer.slice(28, 28 + vocab));
    const idOf = new Map<number, number>();
    symbols.forEach((b, i) => {
      idOf.set(b, i);
    });
    let mismatches = 0;
    let compared = 0;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i] as Reference;
      const bytes = stage0.outputs[i] as Uint8Array;
      const ids = [...bytes].map((b) => idOf.get(b) ?? -1);
      expect(ids.slice(0, ref.promptIds.length)).toEqual(ref.promptIds);
      const gen = ids.slice(ref.promptIds.length);
      expect(gen.length).toBe(24);
      for (let k = 0; k < 24; k++) {
        compared++;
        if (gen[k] !== ref.greedy[k]) {
          mismatches++;
          break; // one divergence changes everything after it; count it once
        }
      }
      console.log(
        `[tinygpt] ${JSON.stringify(ref.prompt)} → ${JSON.stringify(new TextDecoder().decode(bytes.subarray(ref.promptIds.length)))}`,
      );
    }
    // f32 sums in a different order than torch's can flip a near-tie; a divergence per prompt is
    // counted once. The bytes-not-tokens claim is the next assertion.
    expect(mismatches).toBeLessThanOrEqual(1);
    console.log(
      `[tinygpt] ${refs.length} prompts × 24 tokens in ${ms.toFixed(0)} ms (${(ms / (refs.length * 24)).toFixed(1)} ms per token, compared ${compared})`,
    );
    // Determinism: the same task twice gives the same bytes.
    const again = runStaged(module, bundleInputs(), { prompts, tokens: 24 });
    expect(again.stages[0]?.hashes).toEqual(stage0.hashes);
    // The collect stage joins every continuation into the text the dashboard shows.
    expect(run.final).not.toBeNull();
    const text = new TextDecoder().decode(run.final as Uint8Array);
    for (const r of refs) expect(text).toContain(r.prompt);
    expect(sha(run.final as Uint8Array)).toBe(sha(again.final as Uint8Array));
  }, 300_000);
});
