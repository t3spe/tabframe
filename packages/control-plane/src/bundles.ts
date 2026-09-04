// Resolving an uploaded bundle (design §5.2, §5.5): the ledger only knows hashes, so before an
// upload can be launched the process fetches its manifest and module, checks them the way seeding
// checks the shipped programs, and reports a program the core can launch — or a refusal a person
// can act on.
import {
  BUNDLE_PATHS,
  type FsManifest,
  fsManifest,
  LIMITS,
  type ProgramManifest,
  programManifest,
} from "@tabframe/protocol";
import { validateModuleBytes } from "@tabframe/sandbox";
import type { StoreDriver } from "@tabframe/store";

export type BundleResolution =
  | {
      ok: true;
      bundle: string;
      module: string;
      manifest: ProgramManifest;
      files: FsManifest["files"];
    }
  | { ok: false; reason: string };

/** Total bytes a bundle's own files may occupy, so an upload cannot fill the store on its own. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** What a launch may make the control plane read before it says no (WP8.1). */
const BUNDLE_MANIFEST_CAP = 1024 * 1024;
const PROGRAM_MANIFEST_CAP = 64 * 1024;

export async function resolveBundle(
  store: StoreDriver,
  bundle: string,
  memoryPagesMax: number,
): Promise<BundleResolution> {
  const manifestBytes = await store.get(bundle, BUNDLE_MANIFEST_CAP);
  if (!manifestBytes) return { ok: false, reason: "the bundle manifest is not in the store" };
  let fs: FsManifest;
  try {
    fs = fsManifest.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  } catch (err) {
    return { ok: false, reason: `the bundle manifest is not a filesystem manifest: ${short(err)}` };
  }
  const files = fs.files;
  const moduleEntry = files[BUNDLE_PATHS.module];
  if (!moduleEntry) return { ok: false, reason: `the bundle has no ${BUNDLE_PATHS.module}` };
  const manifestEntry = files[BUNDLE_PATHS.manifest];
  if (!manifestEntry) return { ok: false, reason: `the bundle has no ${BUNDLE_PATHS.manifest}` };
  const total = Object.values(files).reduce((n, f) => n + f.size, 0);
  if (total > MAX_BUNDLE_BYTES) {
    return { ok: false, reason: `the bundle is ${total} bytes, cap is ${MAX_BUNDLE_BYTES}` };
  }
  if (moduleEntry.size > LIMITS.maxModuleBytes) {
    return {
      ok: false,
      reason: `the module is ${moduleEntry.size} bytes, cap is ${LIMITS.maxModuleBytes}`,
    };
  }
  // Only `/in/` may carry anything else: an upload cannot smuggle files into `/out/`, whose names
  // the fold owns.
  for (const path of Object.keys(files)) {
    if (path === BUNDLE_PATHS.module || path === BUNDLE_PATHS.manifest) continue;
    if (!path.startsWith(BUNDLE_PATHS.inputs)) {
      return { ok: false, reason: `${path} is outside ${BUNDLE_PATHS.inputs}` };
    }
  }

  const programBytes = await store.get(manifestEntry.hash, PROGRAM_MANIFEST_CAP);
  if (!programBytes) return { ok: false, reason: "the program manifest is not in the store" };
  let manifest: ProgramManifest;
  try {
    manifest = programManifest.parse(JSON.parse(new TextDecoder().decode(programBytes)));
  } catch (err) {
    return { ok: false, reason: `the program manifest is invalid: ${short(err)}` };
  }

  const wasm = await store.get(moduleEntry.hash, LIMITS.maxModuleBytes);
  if (!wasm) return { ok: false, reason: "the module is not in the store" };
  const check = validateModuleBytes(wasm, { memoryPagesMax });
  if (!check.ok) return { ok: false, reason: check.reason };

  return { ok: true, bundle, module: moduleEntry.hash, manifest, files };
}

function short(err: unknown): string {
  return String(err).slice(0, 200);
}
