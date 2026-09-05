// `mise run down`: disable the schedule, terminate every MicroVM, write the off state (D20).
import { maskSecrets } from "../src/mask.ts";
import { operatorDeps } from "../src/operator.ts";
import { down } from "../src/ops.ts";

console.log(maskSecrets(JSON.stringify(await down(await operatorDeps()))));
