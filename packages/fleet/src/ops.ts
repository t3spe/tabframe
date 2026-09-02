// Operator operations behind `mise run up` and `mise run down` (design D20). Logic only; the
// scripts under scripts/ wire real clients and call these.
import type { OpsConfig } from "./config.ts";
import type { PointerStore } from "./pointer.ts";
import type { Invoker, Logger, MicrovmClient, RuleControl, Sleeper } from "./types.ts";

export interface OpsDeps {
  pointer: PointerStore;
  microvms: MicrovmClient;
  invoker: Invoker;
  rules: RuleControl;
  sleep: Sleeper;
  log: Logger;
  config: OpsConfig;
}

/** Clear the off state (keeping the generation) and ask rotate to launch a control plane. */
export async function up(deps: OpsDeps): Promise<unknown> {
  const p = await deps.pointer.read();
  await deps.pointer.write({ ...p, state: "on", updatedAt: new Date().toISOString() });
  await deps.rules.enable(deps.config.ruleName);
  deps.log.info("up: pointer set to on, rotation schedule enabled, invoking rotate");
  return deps.invoker.invokeSync(deps.config.rotateFunctionName, { reason: "up" });
}

/** Off: disable the schedule, terminate every MicroVM from our image, write the off state. */
export async function down(deps: OpsDeps): Promise<{ terminated: string[] }> {
  await deps.rules.disable(deps.config.ruleName);
  const p = await deps.pointer.read();
  await deps.pointer.write({
    ...p,
    state: "off",
    microvmId: null,
    endpoint: null,
    updatedAt: new Date().toISOString(),
  });
  const all = await deps.microvms.list(deps.config.imageArn);
  const terminated: string[] = [];
  for (const vm of all) {
    if (vm.state === "TERMINATED" || vm.state === "TERMINATING") continue;
    await deps.microvms.terminate(vm.microvmId);
    terminated.push(vm.microvmId);
    // The TerminateMicrovm rate quota is 10/s; a short pause keeps a large fleet under it.
    await deps.sleep.sleep(150);
  }
  deps.log.info("down: machine is off", { terminated: terminated.length });
  return { terminated };
}
