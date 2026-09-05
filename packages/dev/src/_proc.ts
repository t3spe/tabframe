// Child processes for the local topology: their output is echoed line by line under a `[name]`
// prefix, so several processes share one terminal legibly.
import { type ChildProcess, spawn } from "node:child_process";

/** Calls `onLine` once per complete, non-empty line, across chunk boundaries. */
export function readLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  let buf = "";
  stream?.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  });
}

export interface PrefixedSpawn {
  cwd: string;
  env?: Record<string, string>;
  /** Which stdout lines to echo; every line by default. */
  echo?: (line: string) => boolean;
  /** Sees every stdout line, echoed or not. */
  onLine?: (line: string) => void;
  /** "prefix" echoes stderr under the same prefix; "inherit" passes it straight through. */
  stderr: "prefix" | "inherit";
}

/** Spawns `cmd` with the process environment plus `env`, echoing its output under `[name]`. */
export function spawnPrefixed(
  name: string,
  cmd: string,
  args: string[],
  opts: PrefixedSpawn,
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", opts.stderr === "prefix" ? "pipe" : "inherit"],
  });
  readLines(child.stdout, (line) => {
    if (opts.echo?.(line) ?? true) process.stdout.write(`[${name}] ${line}\n`);
    opts.onLine?.(line);
  });
  if (opts.stderr === "prefix") {
    readLines(child.stderr, (line) => process.stderr.write(`[${name}] ${line}\n`));
  }
  return child;
}
