// The process entry, and the only file that touches the platform's adapters: the SSM pointer, the
// MicroVM core fleet, the build stamp staged beside the bundle.
import { readFileSync } from "node:fs";
import { SsmPointerStore } from "@tabframe/fleet/aws";
import { configFromEnv } from "./config.ts";
import { createCoreFleet } from "./cores.ts";
import { type BuildStamp, buildStamp } from "./health.ts";
import { log } from "./log.ts";
import { type ControlPlaneDeps, createControlPlane } from "./server.ts";

const config = configFromEnv();
const deps: ControlPlaneDeps = { coreFleet: createCoreFleet, build: resolveBuild() };
if (config.mode === "image" && config.pointerParam) {
  const ssm = new SsmPointerStore(config.pointerParam);
  deps.pointer = () => ssm.read();
}
const cp = await createControlPlane(config, undefined, deps);
log("listening", {
  mode: config.mode,
  role: cp.role,
  generation: cp.generation,
  publicPort: cp.publicAddress.port,
  privatePort: cp.privateAddress.port,
  host: cp.publicAddress.host,
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log("shutdown", { signal });
  await cp.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** The stamp staged beside the entry, unless the environment names a build; a checkout has neither. */
function resolveBuild(): BuildStamp {
  if (!process.env.TABFRAME_BUILD) {
    try {
      return JSON.parse(readFileSync(new URL("./build.json", import.meta.url), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // no stamp beside the entry: a local run
    }
  }
  return buildStamp(process.env);
}
