// `mise run up`: clear the off state, enable the schedule, launch a control plane.
import { up } from "../src/ops.ts";
import { mask, operatorDeps } from "./_deps.ts";

const result = await up(await operatorDeps());
console.log(mask(JSON.stringify(result)));
