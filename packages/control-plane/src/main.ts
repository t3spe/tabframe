import { readFileSync } from "node:fs";
import { configFromEnv } from "./config.ts";
import { log } from "./log.ts";
import { createControlPlane } from "./server.ts";

const config = configFromEnv();
const cp = await createControlPlane(config);
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
// The build stamp the image was staged with (WP8.1), for /health.
try {
  if (!process.env.TABFRAME_BUILD) {
    const stamp = JSON.parse(readFileSync(new URL("./build.json", import.meta.url), "utf8")) as {
      sha?: string;
    };
    if (stamp.sha) process.env.TABFRAME_BUILD = stamp.sha;
    process.env.TABFRAME_BUILD_JSON = JSON.stringify(stamp); // the whole stamp for /health (WP8.3)
  }
} catch {
  // no stamp beside the entry: a local run
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
