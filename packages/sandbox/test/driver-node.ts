// Runs under Node (the production runtime) as a child of the adapter test: a sandbox host with
// the worker-thread adapter, blobs served through the Atomics bridge from an in-memory map.
// Usage: node driver-node.ts <config.json>; prints one JSON line per run.
import { readFileSync } from "node:fs";
import type { FsManifest, TaskLimits } from "@tabframe/protocol";
import { createNodeSandboxHost } from "../src/adapters/node-host.ts";

interface Config {
  wasm: string;
  regionBytes: number;
  manifest: FsManifest;
  limits: TaskLimits;
  blobs: Record<string, string>;
  runs: Array<{ kind: "run" | "plan"; input: string; deadlineMs: number }>;
}

const config = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as Config;
const b64 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64"));
const blobs = new Map(Object.entries(config.blobs).map(([h, s]) => [h, b64(s)]));
let fetches = 0;

const host = createNodeSandboxHost({
  regionBytes: config.regionBytes,
  fetchBlob: async (hash, offset, len) => {
    fetches++;
    const whole = blobs.get(hash);
    if (!whole) return null;
    const end = Number.isFinite(len) ? Math.min(whole.length, offset + len) : whole.length;
    return whole.slice(offset, end);
  },
});

const module = new WebAssembly.Module(b64(config.wasm));
for (const r of config.runs) {
  const started = Date.now();
  const result = await host.run(
    module,
    { kind: r.kind, input: b64(r.input), manifest: config.manifest, limits: config.limits },
    r.deadlineMs,
  );
  const line = result.ok
    ? {
        ok: true,
        output: Buffer.from(result.output).toString("base64"),
        writes: Object.fromEntries(
          [...result.writes].map(([p, v]) => [p, Buffer.from(v).toString("base64")]),
        ),
        log: result.log,
        elapsedMs: Date.now() - started,
        fetches,
      }
    : { ok: false, error: result.error, log: result.log, elapsedMs: Date.now() - started, fetches };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
host.dispose();
