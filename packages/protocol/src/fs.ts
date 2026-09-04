import { z } from "zod";
import { hash } from "./shared.ts";

/** A path inside an execution's filesystem or a bundle: absolute, normalized, no traversal. */
export const fsPath = z
  .string()
  .min(2)
  .max(512)
  .regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/, "absolute path with simple segments")
  .refine((p) => p.split("/").every((seg) => seg !== "." && seg !== ".."), "no dot segments");

export const fileEntry = z.object({ hash, size: z.number().int().nonnegative() });

/**
 * A manifest blob: the whole filesystem (or bundle) as path → blob. Stored content-addressed
 * itself, so a filesystem is one root hash (design §5.4).
 */
export const fsManifest = z.object({
  version: z.literal(1),
  files: z.record(fsPath, fileEntry),
});
export type FsManifest = z.infer<typeof fsManifest>;

/** What a program declares about itself (design §5.1). */
export const programManifest = z.object({
  name: z.string().min(1).max(64),
  view: z.enum(["tiles", "bars", "text"]),
  persist: z.boolean().default(false),
  defaultParams: z.record(z.string(), z.unknown()).default({}),
  description: z.string().max(512).optional(),
  /**
   * The hash of the program's source text in the store (WP7.6): the editor uploads it with the
   * module and can reopen the program on any browser; the seeder sets it for shipped programs.
   * Absent for a module dropped as a .wasm.
   */
  source: hash.optional(),
});
export type ProgramManifest = z.infer<typeof programManifest>;

/** Fixed paths inside a bundle. */
export const BUNDLE_PATHS = {
  module: "/program.wasm",
  manifest: "/manifest.json",
  inputs: "/in/",
} as const;
