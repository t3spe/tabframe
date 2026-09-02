// `mise run deploy` ends with this: invoke the deployed rotate function and print its result.
import { mask, operatorDeps } from "./_deps.ts";

const deps = await operatorDeps();
const result = await deps.invoker.invokeSync(deps.config.rotateFunctionName, {
  reason: "operator",
});
console.log(mask(JSON.stringify(result)));
