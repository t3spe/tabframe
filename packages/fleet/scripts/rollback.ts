// `mise run rollback -- <imageVersion>` pins the machine to an image version and rotates onto it;
// `mise run rollback -- --clear` removes the pin. The pin holds until the next deploy (`up` clears
// it) or an explicit clear.
import { maskSecrets } from "../src/mask.ts";
import { operatorDeps } from "../src/operator.ts";
import { pin, rotateNow } from "../src/ops.ts";

const arg = process.argv[2];
if (!arg || (arg !== "--clear" && !/^\d+$/.test(arg))) {
  console.error("usage: rollback.ts <imageVersion> | --clear");
  process.exit(2);
}

const deps = await operatorDeps();
await pin(deps, arg === "--clear" ? null : arg);
console.log(arg === "--clear" ? "image pin cleared" : `image pinned to version ${arg}`);
console.log(maskSecrets(JSON.stringify(await rotateNow(deps, "operator"))));
