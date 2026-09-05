// `mise run up`: clear the off state, enable the schedule, launch a control plane.
import { maskSecrets } from "../src/mask.ts";
import { operatorDeps } from "../src/operator.ts";
import { up } from "../src/ops.ts";

console.log(maskSecrets(JSON.stringify(await up(await operatorDeps()))));
