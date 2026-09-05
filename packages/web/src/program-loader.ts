// A program as the machine has it, read back from the store by hash: its bundle names its
// manifest, its module, and its inputs; the manifest names its source when it has one.
import {
  BUNDLE_PATHS,
  fsManifest,
  type ProgramManifest,
  programManifest,
} from "@tabframe/protocol";
import type { InputRef } from "./editor-core.ts";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** One blob from the store, or a throw naming the hash and the status. */
export async function fetchBlob(storeBase: string, hash: string): Promise<Uint8Array> {
  const r = await fetch(`${storeBase.replace(/\/$/, "")}/${hash}`);
  if (!r.ok) throw new Error(`${hash.slice(0, 8)}…: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export interface LoadedBundle {
  manifest: ProgramManifest;
  /** The module's hash, for a program with no source: the module itself is what gets loaded. */
  moduleHash: string;
  /** Inputs kept by hash: a launch of an edited copy names them, never re-uploads them. */
  inputRefs: InputRef[];
}

/** The bundle's manifest and what it points at; the source or module is fetched by the caller as needed. */
export async function loadBundle(storeBase: string, bundle: string): Promise<LoadedBundle> {
  const fs = fsManifest.parse(JSON.parse(decode(await fetchBlob(storeBase, bundle))));
  const manifestEntry = fs.files[BUNDLE_PATHS.manifest];
  const moduleEntry = fs.files[BUNDLE_PATHS.module];
  if (!manifestEntry || !moduleEntry) throw new Error("the bundle lacks its manifest or module");
  const manifest = programManifest.parse(
    JSON.parse(decode(await fetchBlob(storeBase, manifestEntry.hash))),
  );
  const inputRefs: InputRef[] = Object.entries(fs.files)
    .filter(([path]) => path.startsWith(BUNDLE_PATHS.inputs))
    .map(([path, e]) => ({ path, hash: e.hash, size: e.size }));
  return { manifest, moduleHash: moduleEntry.hash, inputRefs };
}
