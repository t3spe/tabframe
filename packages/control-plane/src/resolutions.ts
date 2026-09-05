import { DEFAULT_TASK_LIMITS } from "@tabframe/core";
import type { StoreDriver } from "@tabframe/store";
import { type BundleResolution, resolveBundle } from "./bundles.ts";

/** Bundle resolutions remembered per process. */
export const RESOLUTION_MEMO = 32;

/**
 * Resolutions are memoised, rejections included, and never run twice at once: one uploaded
 * eight-megabyte module would otherwise cost a fetch and a validation per launch attempt.
 */
export function createBundleResolver(
  store: StoreDriver,
  memoryPagesMax: number = DEFAULT_TASK_LIMITS.memoryPagesMax,
): (bundle: string) => Promise<BundleResolution> {
  const resolutions = new Map<string, Promise<BundleResolution>>();
  return (bundle) => {
    const known = resolutions.get(bundle);
    if (known) return known;
    const pending = resolveBundle(store, bundle, memoryPagesMax);
    resolutions.set(bundle, pending);
    while (resolutions.size > RESOLUTION_MEMO) {
      const oldest = resolutions.keys().next().value;
      if (oldest === undefined) break;
      resolutions.delete(oldest);
    }
    return pending;
  };
}
