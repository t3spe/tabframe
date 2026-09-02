import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

// Integration: a real control plane and a real node, both under Node.
const CP_MAIN = path.resolve(import.meta.dir, "../../../control-plane/src/main.ts");
const NODE_MAIN = path.resolve(import.meta.dir, "node.ts");
let cp: ChildProcess;
let node: ChildProcess;
let pub = "";
let priv = "";

function spawnJson(
  file: string,
  env: Record<string, string>,
  until: string,
): Promise<{ child: ChildProcess; line: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [file], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        if (line.includes(until))
          resolve({ child, line: JSON.parse(line) as Record<string, unknown> });
      }
    });
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
    setTimeout(() => reject(new Error(`${file} did not print ${until}`)), 15_000);
  });
}

async function health(): Promise<{ nodes: number }> {
  return (await (await fetch(`${priv}/health`)).json()) as { nodes: number };
}

async function waitFor(pred: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met in time");
}

beforeAll(async () => {
  const started = await spawnJson(
    CP_MAIN,
    {
      TABFRAME_MODE: "local",
      TABFRAME_PUBLIC_PORT: "0",
      TABFRAME_PRIVATE_PORT: "0",
      TABFRAME_TICK_MS: "50",
    },
    '"listening"',
  );
  cp = started.child;
  pub = `http://${started.line.host}:${started.line.publicPort}`;
  priv = `http://${started.line.host}:${started.line.privatePort}`;
});
afterAll(async () => {
  node?.kill("SIGTERM");
  cp.kill("SIGTERM");
  await new Promise((r) => cp.once("exit", r));
});

describe("node platform against a real control plane", () => {
  test("the process joins as a core node and leaves when killed", async () => {
    expect((await health()).nodes).toBe(0);
    const started = await spawnJson(
      NODE_MAIN,
      { TABFRAME_SESSION_URL: `${pub}/session`, TABFRAME_HOST_ID: "core-test" },
      '"idle"',
    );
    node = started.child;
    expect(started.line.nodeId).toBe("n1");
    expect(started.line.state).toBe("idle");
    expect((await health()).nodes).toBe(1);
    node.kill("SIGTERM");
    await new Promise((r) => node.once("exit", r));
    await waitFor(async () => (await health()).nodes === 0);
  }, 20_000);

  test("without a session URL the process exits with code 2", async () => {
    const child = spawn("node", [NODE_MAIN], {
      env: { ...process.env, TABFRAME_SESSION_URL: "" },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).toBe(2);
  });
});
