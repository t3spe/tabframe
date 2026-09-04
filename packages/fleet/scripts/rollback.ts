// `mise run rollback -- <imageVersion>` pins the machine to an earlier image version and rotates
// onto it; `mise run rollback -- --clear` removes the pin (WP8.2, reworked in WP8.3). The pin is a
// field of the pointer, read by every rotation — hourly ones included — and cleared by `up`, which
// ends every deploy; so a rollback holds until the next deploy or an explicit clear.
import { mask, operatorDeps } from "./_deps.ts";

const arg = process.argv[2];
if (!arg || (arg !== "--clear" && !/^\d+$/.test(arg))) {
  console.error("usage: rollback.ts <imageVersion> | --clear");
  process.exit(2);
}

const deps = await operatorDeps();
const p = await deps.pointer.read();
await deps.pointer.write({
  ...p,
  pinnedImageVersion: arg === "--clear" ? null : arg,
  updatedAt: new Date().toISOString(),
});
console.log(arg === "--clear" ? "image pin cleared" : `image pinned to version ${arg}`);
const result = await deps.invoker.invokeSync(deps.config.rotateFunctionName, {
  reason: "operator",
});
console.log(mask(JSON.stringify(result)));
