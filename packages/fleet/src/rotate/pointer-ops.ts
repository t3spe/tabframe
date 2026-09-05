// Every write a rotation makes to the pointer. Nothing else under rotate/ writes it, so the
// pointer's transitions are these four functions.
import type { ControlPlaneTarget } from "../cp-client.ts";
import type { Pointer, PointerStore } from "../pointer.ts";
import type { MicrovmInfo } from "../types.ts";
import type { RotateDeps } from "./index.ts";
import { terminateQuietly } from "./retire.ts";

/** Name a freshly launched successor before waiting for it: a run that dies waiting leaves a record. */
export function recordPending(
  store: PointerStore,
  base: Pointer,
  launched: MicrovmInfo,
  generation: number,
  at: number,
): Promise<void> {
  return store.write({
    ...base,
    pending: { microvmId: launched.microvmId, endpoint: launched.endpoint, generation, at },
  });
}

/** Forget the pending successor: from `base` when given, otherwise from the pointer as it stands. */
export async function clearPending(store: PointerStore, base?: Pointer): Promise<void> {
  await store.write({ ...(base ?? (await store.read())), pending: null });
}

/** Forget the predecessor a rotation has finished retiring. */
export async function clearRetiring(store: PointerStore): Promise<void> {
  await store.write({ ...(await store.read()), retiring: null });
}

/**
 * Flip the pointer to `vm`. The pointer is read again first: a `down` that landed during the
 * launch wins, and the successor is terminated instead. `retiring` names the predecessor until it
 * is drained and gone, so a run that dies after the flip is finished by the next one.
 */
export async function promote(
  deps: Pick<RotateDeps, "pointer" | "microvms" | "log">,
  base: Pointer,
  vm: MicrovmInfo,
  generation: number,
  now: number,
  retiring: ControlPlaneTarget | null = null,
): Promise<boolean> {
  const fresh = await deps.pointer.read();
  if (fresh.state === "off") {
    deps.log.warn("rotate: the machine was turned off during the rotation; not promoting", {
      microvmId: vm.microvmId,
    });
    await terminateQuietly(deps, vm.microvmId, "turned off during the rotation");
    return false;
  }
  await deps.pointer.write({
    ...base,
    state: "on",
    microvmId: vm.microvmId,
    endpoint: vm.endpoint,
    generation,
    imageVersion: vm.imageVersion,
    updatedAt: new Date(now).toISOString(),
    pending: null,
    retiring: retiring ? { microvmId: retiring.microvmId, endpoint: retiring.endpoint } : null,
  });
  return true;
}
