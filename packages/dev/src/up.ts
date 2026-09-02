// `mise run dev`: the whole machine on a laptop (design §12).
//   control plane (node --watch, local mode, serving the web bundle) + two local cores (the Node
//   platform, stand-ins for the MicroVM cores) + the web build in watch mode.
// Flags: --no-watch (tests and CI: build once, no file watching). Ports come from
// TABFRAME_PUBLIC_PORT / TABFRAME_PRIVATE_PORT (defaults 4080/4081; 0 picks free ports).
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const watch = !process.argv.includes("--no-watch");
const cores = Number(process.env.TABFRAME_LOCAL_CORES ?? "2");
const children = new Map<string, ChildProcess>();
let shuttingDown = false;

function say(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

function run(
  name: string,
  cmd: string,
  args: string[],
  env: Record<string, string>,
  onLine?: (line: string) => void,
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(name, child);
  const prefix = (stream: NodeJS.ReadableStream | null, isErr: boolean) => {
    let buf = "";
    stream?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        (isErr ? process.stderr : process.stdout).write(`[${name}] ${line}\n`);
        onLine?.(line);
      }
    });
  };
  prefix(child.stdout, false);
  prefix(child.stderr, true);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    say("child-exit", { name, code, signal });
    if (name.startsWith("core-")) {
      // A local core that dies comes back, the way the fleet policy replaces a cloud core.
      setTimeout(() => {
        if (!shuttingDown) startCore(name);
      }, 1_000);
    }
  });
  return child;
}

let sessionUrl = "";
function startCore(name: string): void {
  run(name, "node", ["packages/node/src/platform/node.ts"], {
    TABFRAME_SESSION_URL: sessionUrl,
    TABFRAME_HOST_ID: name,
  });
}

// 1. Compile the demo programs and build the web bundle once (watch mode keeps rebuilding the
//    bundle in the background). The control plane seeds programs/<name>/dist at boot.
function buildStep(name: string, cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const b = spawn(cmd, args, { cwd: root, stdio: "inherit" });
    b.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} failed (${code})`)),
    );
  });
}
await buildStep("build:programs", "node", ["packages/sdk-as/scripts/build-programs.ts"]);
await buildStep("build:web", "bun", ["packages/web/scripts/build.ts"]);
if (watch) run("web", "bun", ["packages/web/scripts/build.ts", "--watch"], {});

// 2. Control plane, local mode, serving the bundle.
const cpArgs = watch
  ? ["--watch", "packages/control-plane/src/main.ts"]
  : ["packages/control-plane/src/main.ts"];
await new Promise<void>((resolve) => {
  run(
    "cp",
    "node",
    cpArgs,
    {
      TABFRAME_MODE: "local",
      TABFRAME_PUBLIC_PORT: process.env.TABFRAME_PUBLIC_PORT ?? "4080",
      TABFRAME_PRIVATE_PORT: process.env.TABFRAME_PRIVATE_PORT ?? "4081",
      TABFRAME_WEB_DIR: "packages/web/dist",
    },
    (line) => {
      if (!line.includes('"listening"')) return;
      const info = JSON.parse(line) as { host: string; publicPort: number; privatePort: number };
      const pub = `http://${info.host}:${info.publicPort}`;
      sessionUrl = `${pub}/session`;
      say("dev-ready", {
        url: pub,
        health: `http://${info.host}:${info.privatePort}/health`,
        cores,
      });
      process.stdout.write(
        `\n  Tabframe local machine\n  page    ${pub}\n  health  http://${info.host}:${info.privatePort}/health\n  cores   ${cores} local\n\n`,
      );
      resolve();
    },
  );
});

// 3. Local cores.
for (let i = 1; i <= cores; i++) startCore(`core-${i}`);

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  say("shutdown", { signal });
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
