import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { spawnProcess, until } from "../../../control-plane/src/testing.ts";

// Integration: a real control plane and a real node, both under Node.
const CP_MAIN = path.resolve(import.meta.dir, "../../../control-plane/src/main.ts");
const NODE_MAIN = path.resolve(import.meta.dir, "node.ts");
let cp: ChildProcess;
let node: ChildProcess;
let pub = "";
let priv = "";

async function health(): Promise<{ nodes: number }> {
  return (await (await fetch(`${priv}/health`)).json()) as { nodes: number };
}

beforeAll(async () => {
  const started = await spawnProcess(
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
    const started = await spawnProcess(
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
    await until(async () => (await health()).nodes === 0, 8_000, "the node to leave", 100);
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
