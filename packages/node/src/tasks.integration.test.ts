// The runner with the real sandbox (worker thread, bridge reader) and the real Mandelbrot module:
// plan stage 0, run a tile, and match the golden hash the SDK test suite pins.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type Assign,
  decodeStageSpec,
  encodePlanInput,
  PROTOCOL_VERSION,
  type StageSpec,
} from "@tabframe/protocol";
import { createNodeSandboxHost } from "@tabframe/sandbox/adapters/node-host";
import { type PresignRequester, StoreClient, sha256Hex } from "@tabframe/store";
import { compileProgram } from "../../sdk-as/scripts/build-programs.ts";
import { TaskRunner } from "./tasks.ts";

const root = path.resolve(import.meta.dir, "../../..");
const programDir = path.join(root, "programs", "mandelbrot");
const out = path.join(import.meta.dir, "..", "dist-test", "mandelbrot.wasm");
const goldens = JSON.parse(readFileSync(path.join(programDir, "goldens.json"), "utf8")) as {
  params: Record<string, unknown>;
  taskCount: number;
  hashes: string[];
};
const BASE = "http://store.test/blob";
const limits = {
  maxOutputBytes: 1 << 24,
  maxWriteBytes: 1 << 24,
  maxWriteFiles: 256,
  maxLogBytes: 1 << 16,
  memoryPagesMax: 256,
};

const blobs = new Map<string, Uint8Array>();
const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
  const hash = url.slice(BASE.length + 1);
  if (init?.method === "PUT") {
    blobs.set(hash, new Uint8Array(init.body as ArrayBuffer));
    return new Response(null, { status: 200 });
  }
  const b = blobs.get(hash);
  return b
    ? new Response(b as unknown as BodyInit, { status: 200 })
    : new Response(null, { status: 404 });
};
const requester: PresignRequester = {
  presign: async (items) =>
    items.map((i) => ({
      hash: i.hash,
      url: blobs.has(i.hash) ? null : `${BASE}/${i.hash}`,
      headers: {},
    })),
};
const store = new StoreClient(BASE, requester, fetchImpl);
let program = "";
let runner: TaskRunner;

beforeAll(async () => {
  await compileProgram(path.join(programDir, "assembly", "index.ts"), out);
  const wasm = new Uint8Array(readFileSync(out));
  program = await sha256Hex(wasm);
  blobs.set(program, wasm);
  runner = new TaskRunner({
    store,
    createSandbox: () =>
      createNodeSandboxHost({
        fetchBlob: async (hash, offset, len) => {
          const b = blobs.get(hash);
          if (!b) return null;
          return Number.isFinite(len) ? b.slice(offset, offset + len) : b.slice(offset);
        },
      }),
    compile: (bytes) => WebAssembly.compile(bytes as BufferSource),
    now: () => Date.now(),
  });
}, 60_000);

type Fixed = Omit<Assign, "kind" | "stage" | "index" | "count" | "input">;
const base = (taskId: string): Fixed => ({
  t: "assign",
  v: PROTOCOL_VERSION,
  gen: 1,
  taskId,
  attempt: 1,
  executionId: "e1",
  program,
  fsRoot: null,
  deadlineMs: 10_000,
  limits,
});

describe("Mandelbrot through the runner and the real sandbox", () => {
  let spec: StageSpec;

  test("plan stage 0 uploads a stage spec with 640 tasks", async () => {
    const input = encodePlanInput({ stage: 0, params: goldens.params, hints: {} });
    const outcome = await runner.run(
      {
        ...base("plan-0"),
        kind: "plan",
        stage: 0,
        index: 0,
        count: 1,
        input: Buffer.from(input).toString("base64"),
      },
      1,
    );
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.msg.error).toBeUndefined();
    const bytes = blobs.get(outcome.msg.output as string);
    expect(bytes).toBeDefined();
    spec = decodeStageSpec(bytes as Uint8Array);
    expect(spec.kind).toBe("stage");
    if (spec.kind !== "stage") return;
    expect(spec.tasks.length).toBe(goldens.taskCount);
  }, 30_000);

  test("tile 0 renders 64×64 RGBA bytes matching the golden hash", async () => {
    if (spec.kind !== "stage") throw new Error("no spec");
    const task = spec.tasks[0] as { input: Uint8Array };
    const outcome = await runner.run(
      {
        ...base("tile-0"),
        kind: "run",
        stage: 0,
        index: 0,
        count: spec.tasks.length,
        input: Buffer.from(task.input).toString("base64"),
      },
      1,
    );
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.msg.error).toBeUndefined();
    expect(outcome.msg.outputSize).toBe(64 * 64 * 4);
    expect(outcome.msg.output).toBe(goldens.hashes[0] as string);
    expect(outcome.msg.computeMs).toBeGreaterThan(0);
    runner.abort();
  }, 30_000);
});
