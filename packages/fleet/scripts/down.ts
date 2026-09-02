// `mise run down`: disable the schedule, terminate every MicroVM, write the off state (D20).
import { down } from "../src/ops.ts";
import { mask, operatorDeps } from "./_deps.ts";

const result = await down(await operatorDeps());
console.log(mask(JSON.stringify(result)));
