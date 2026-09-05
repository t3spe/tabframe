// `mise run rotate`: one rotation now, the same code the hourly rule runs; the result printed.
import { maskSecrets } from "../src/mask.ts";
import { operatorDeps } from "../src/operator.ts";
import { rotateNow } from "../src/ops.ts";

console.log(maskSecrets(JSON.stringify(await rotateNow(await operatorDeps(), "operator"))));
