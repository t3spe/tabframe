// Test-only helpers shared by the control-plane suites (and the node platform suite).
import { type ChildProcess, spawn } from "node:child_process";
import type { ImageConfig } from "./config.ts";
import { HOOK_PREFIX } from "./hooks.ts";
import type { Address } from "./server.ts";

/** An image-mode configuration for in-process tests: free ports, fast ticks, open fleet routes. */
export function testConfig(overrides: Partial<Omit<ImageConfig, "mode">> = {}): ImageConfig {
  return {
    mode: "image",
    allowOpenFleetRoutes: true,
    publicPort: 0,
    privatePort: 0,
    host: "127.0.0.1",
    generation: 1,
    storeBase: null,
    webDir: null,
    blobBucket: null,
    snapshotBucket: null,
    pointerParam: null,
    cores: null,
    tickMs: 50,
    programsDir: null,
    defaultProgram: "mandelbrot",
    snapshotEveryMs: 60_000,
    coreCheckMs: 60_000,
    region: "us-west-2",
    sessionUrl: null,
    ...overrides,
  };
}

/** Poll until `pred` holds: timer-driven state has no promise to await. */
export async function until(
  pred: () => boolean | Promise<boolean>,
  ms: number,
  what: string,
  everyMs = 25,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(everyMs);
  }
}

export function privateUrl(cp: { privateAddress: Address }, path: string): string {
  return `http://${cp.privateAddress.host}:${cp.privateAddress.port}${path}`;
}

export function publicUrl(cp: { publicAddress: Address }, path: string): string {
  return `http://${cp.publicAddress.host}:${cp.publicAddress.port}${path}`;
}

/** POST a lifecycle hook on the private port, with the body the platform would send. */
export function hook(
  cp: { privateAddress: Address },
  name: string,
  body?: unknown,
): Promise<Response> {
  return fetch(
    privateUrl(cp, `${HOOK_PREFIX}${name}`),
    body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) },
  );
}

/** The /run hook with a stringified payload, as the platform delivers it. */
export async function runHook(
  cp: { privateAddress: Address },
  payload: Record<string, unknown>,
  microvmId = "vm-1",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await hook(cp, "run", { microvmId, runHookPayload: JSON.stringify(payload) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export interface SpawnedProcess {
  child: ChildProcess;
  /** The first JSON log line that contained `until`. */
  line: Record<string, unknown>;
}

export interface SpawnOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Every complete stdout line, before and after the awaited one. */
  onLine?: (line: string) => void;
  /** Forward stderr with this prefix; omitted, stderr is forwarded as is. */
  stderrPrefix?: string;
}

/** Spawn a Node entry (the production runtime), and resolve on the first log line containing `until`. */
export function spawnProcess(
  file: string,
  env: Record<string, string>,
  until: string,
  opts: SpawnOptions = {},
): Promise<SpawnedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [file], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let seen = false;
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        opts.onLine?.(line);
        if (seen || !line.includes(until)) continue;
        seen = true;
        resolve({ child, line: JSON.parse(line) as Record<string, unknown> });
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(opts.stderrPrefix ? `${opts.stderrPrefix}${d.toString()}` : d);
    });
    child.on("exit", (code) => {
      if (!seen) reject(new Error(`${file} exited with ${code} before printing ${until}`));
    });
    setTimeout(() => {
      if (!seen) reject(new Error(`${file} did not print ${until}`));
    }, opts.timeoutMs ?? 15_000);
  });
}
