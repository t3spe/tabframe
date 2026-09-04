// `mise run rollback -- <imageVersion>` pins the rotate function to an earlier image version and
// rotates onto it; `mise run rollback -- --clear` removes the pin (WP8.2, finding 27 of loop 1).
// The pin is the function's TABFRAME_IMAGE_VERSION, read at every invocation, so it also holds
// for the hourly rotations until it is cleared — a deploy clears it by redeploying the function.
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { mask, operatorDeps } from "./_deps.ts";

const arg = process.argv[2];
if (!arg || (arg !== "--clear" && !/^\d+$/.test(arg))) {
  console.error("usage: rollback.ts <imageVersion> | --clear");
  process.exit(2);
}

const deps = await operatorDeps();
const lambda = new LambdaClient({});
const name = deps.config.rotateFunctionName;
const current = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
const variables = { ...(current.Environment?.Variables ?? {}) };
if (arg === "--clear") delete variables.TABFRAME_IMAGE_VERSION;
else variables.TABFRAME_IMAGE_VERSION = arg;
await lambda.send(
  new UpdateFunctionConfigurationCommand({
    FunctionName: name,
    Environment: { Variables: variables },
  }),
);
// The configuration update is asynchronous; an invoke before it lands would run the old pin.
for (let i = 0; i < 30; i++) {
  const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
  if (c.LastUpdateStatus === "Successful") break;
  if (c.LastUpdateStatus === "Failed")
    throw new Error(`rotate function update failed: ${c.LastUpdateStatusReason}`);
  await deps.sleep.sleep(1_000);
}
console.log(arg === "--clear" ? "image pin cleared" : `image pinned to version ${arg}`);
const result = await deps.invoker.invokeSync(name, { reason: "operator" });
console.log(mask(JSON.stringify(result)));
