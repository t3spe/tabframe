import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

const UP = path.resolve(import.meta.dir, "up.ts");
let up: ChildProcess | undefined;

afterAll(async () => {
  if (!up) return;
  up.kill("SIGTERM");
  await new Promise((r) => up?.once("exit", r));
});

describe("dev topology", () => {
  test("brings up a control plane with two local cores and tears everything down", async () => {
    const ready = await new Promise<{ url: string; health: string; cores: number }>(
      (resolve, reject) => {
        up = spawn("node", [UP, "--no-watch"], {
          env: { ...process.env, TABFRAME_PUBLIC_PORT: "0", TABFRAME_PRIVATE_PORT: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let buf = "";
        up.stdout?.on("data", (d: Buffer) => {
          buf += d.toString();
          for (const line of buf.split("\n")) {
            if (line.startsWith("{") && line.includes('"dev-ready"'))
              resolve(JSON.parse(line) as { url: string; health: string; cores: number });
          }
        });
        up.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
        up.once("exit", (code) => reject(new Error(`up exited early: ${code}`)));
        setTimeout(() => reject(new Error("dev topology did not become ready")), 40_000);
      },
    );
    expect(ready.cores).toBe(2);
    const t0 = Date.now();
    let nodes = 0;
    while (Date.now() - t0 < 15_000) {
      nodes = ((await (await fetch(ready.health)).json()) as { nodes: number }).nodes;
      if (nodes === 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(nodes).toBe(2);
    const config = (await (await fetch(`${ready.url}/config.json`)).json()) as {
      sessionUrl: string;
    };
    expect(config.sessionUrl).toBe("/session");
    const page = await (await fetch(`${ready.url}/`)).text();
    expect(page).toContain("TABFRAME");

    // Tear down: every child must be gone with the parent.
    const child = up as ChildProcess;
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    up = undefined;
    await new Promise((r) => setTimeout(r, 300));
    await expect(fetch(ready.health)).rejects.toBeDefined();
  }, 60_000);
});
