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
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
