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
  // `up` ends every deploy, so it is where a rollback pin is cleared (WP8.3): the next launch is
  // the image's latest version again.
  if (p.pinnedImageVersion)
    deps.log.info("up: clearing the image pin", { pinned: p.pinnedImageVersion });
  await deps.pointer.write({
    ...p,
    state: "on",
    pinnedImageVersion: null,
    updatedAt: new Date().toISOString(),
  });
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
  const terminated: string[] = [];
  // Two passes (WP8.3): a rotation racing `down` may launch a successor after the first list.
  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) await deps.sleep.sleep(2_000);
    const all = await deps.microvms.list(deps.config.imageArn);
    for (const vm of all) {
      if (vm.state === "TERMINATED" || vm.state === "TERMINATING") continue;
      if (terminated.includes(vm.microvmId)) continue;
      await deps.microvms.terminate(vm.microvmId);
      terminated.push(vm.microvmId);
      // The TerminateMicrovm rate quota is 10/s; a short pause keeps a large fleet under it.
      await deps.sleep.sleep(150);
    }
  }
  deps.log.info("down: machine is off", { terminated: terminated.length });
  return { terminated };
}
