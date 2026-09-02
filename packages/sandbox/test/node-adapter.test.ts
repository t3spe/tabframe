import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileFixture } from "./compile.ts";
import { blobs, dec, limits, manifest, modeInput } from "./helpers.ts";

const DRIVER = path.resolve(import.meta.dir, "driver-node.ts");
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

interface Line {
  ok: boolean;
  output?: string;
  error?: string;
  log?: string;
  writes?: Record<string, string>;
  elapsedMs: number;
  fetches: number;
}

async function drive(
  wasm: Uint8Array,
  runs: Array<{ kind: "run" | "plan"; input: Uint8Array; deadlineMs: number }>,
  regionBytes = 8,
): Promise<Line[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "tabframe-sandbox-"));
  const file = path.join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      wasm: b64(wasm),
      regionBytes,
      manifest,
      limits,
      blobs: Object.fromEntries(Object.entries(blobs).map(([h, v]) => [h, b64(v)])),
      runs: runs.map((r) => ({ kind: r.kind, input: b64(r.input), deadlineMs: r.deadlineMs })),
    }),
  );
  return new Promise((resolve, reject) => {
    const child = spawn("node", [DRIVER, file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`driver exited ${code}: ${err}`));
      resolve(
        out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Line),
      );
    });
  });
}

describe("node adapter under a real Node process", () => {
  test("reads flow through the Atomics bridge in chunks, and the result comes back whole", async () => {
    const wasm = await compileFixture("fs", { maximumMemory: 256 });
    const [line] = await drive(wasm, [{ kind: "run", input: modeInput(0), deadlineMs: 5_000 }], 8);
    expect(line?.ok).toBe(true);
    expect(dec.decode(Buffer.from(line?.output ?? "", "base64"))).toBe(
      "size=11;list=/in/a.txt\n/in/b.txt;data=hello world;rc=0",
    );
    expect(dec.decode(Buffer.from(line?.writes?.["/out/copy.txt"] ?? "", "base64"))).toBe(
      "hello world",
    );
    expect(line?.log).toBe("hello world");
    // 11 bytes through an 8-byte region takes two chunks; the caching reader asks once per blob.
    expect(line?.fetches).toBe(2);
  }, 30_000);

  test("a spinning loop is killed at the deadline and the host recovers with a fresh worker", async () => {
    const loop = await compileFixture("loop", { maximumMemory: 256 });
    const lines = await drive(loop, [
      { kind: "run", input: new Uint8Array(0), deadlineMs: 400 },
      { kind: "plan", input: new Uint8Array(0), deadlineMs: 400 },
    ]);
    expect(lines.map((l) => l.error)).toEqual(["deadline", "deadline"]);
    for (const l of lines) expect(l.elapsedMs).toBeLessThan(3_000);
  }, 30_000);

  test("after a deadline kill the same host runs a normal task", async () => {
    // Two programs in one driver run is not supported; prove recovery with the fs program:
    // mode 0 twice, the second after a worker replacement forced by an absurdly short deadline.
    const wasm = await compileFixture("fs", { maximumMemory: 256 });
    const lines = await drive(wasm, [
      { kind: "run", input: modeInput(0), deadlineMs: 0 },
      { kind: "run", input: modeInput(0), deadlineMs: 5_000 },
    ]);
    expect(lines[0]?.error).toBe("deadline");
    expect(lines[1]?.ok).toBe(true);
  }, 30_000);
});
