// Assembling the MicroVM image staging directory from the real control-plane bundle:
//   Dockerfile + package.json (ESM) + main.js + node-worker.js + build.json + programs/
// `cdk deploy` ships it as the image's code artifact; the committed packages/infra/image/ holds a
// placeholder so the image builds before the control plane exists.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The staging's top level, which is exactly what the Dockerfile must COPY. */
export const STAGED_FILES = [
  "package.json",
  "main.js",
  "node-worker.js",
  "programs/",
  "build.json",
] as const;

/** What /health shows about the image it runs, so a running generation is traceable to a commit. */
export interface BuildStamp {
  sha: string;
  branch: string;
  ungated: boolean;
  at: string | null;
}

export interface StagedManifest {
  out: string;
  stamp: BuildStamp;
  /** The programs staged, by name. */
  programs: string[];
  /** The staging's top-level entries, as the filesystem lists them. */
  entries: string[];
}

/** `git <args>` in `cwd`, or null outside a checkout. */
export function git(args: string, cwd: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `at` is the commit's time, not the build's: a wall-clock stamp made every deploy a new image
 * version and a platform build even for a docs-only commit.
 */
export function buildStamp(root: string, env: Record<string, string | undefined>): BuildStamp {
  const head = git("rev-parse --short HEAD", root);
  const dirty = head !== null && (git("status --porcelain", root) ?? "") !== "";
  return {
    sha: head ? `${head}${dirty ? "-dirty" : ""}` : "unknown",
    branch: git("rev-parse --abbrev-ref HEAD", root) ?? "unknown",
    ungated: env.TABFRAME_DEPLOY_UNGATED === "1",
    at: git("show -s --format=%cI HEAD", root) || null,
  };
}

/**
 * Compiled programs: programs/<name>/dist/* → <name>/, the inputs the control plane seeds as
 * /in/<file> of the bundle, and the source the editor opens the shipped program from.
 */
function stagePrograms(programs: string, out: string): string[] {
  const staged: string[] = [];
  if (!existsSync(programs)) return staged;
  for (const name of readdirSync(programs)) {
    const dist = path.join(programs, name, "dist");
    if (!existsSync(dist)) continue;
    mkdirSync(path.join(out, name), { recursive: true });
    for (const f of readdirSync(dist)) copyFileSync(path.join(dist, f), path.join(out, name, f));
    const inputs = path.join(programs, name, "in");
    if (existsSync(inputs)) {
      mkdirSync(path.join(out, name, "in"), { recursive: true });
      for (const f of readdirSync(inputs))
        copyFileSync(path.join(inputs, f), path.join(out, name, "in", f));
    }
    const source = path.join(programs, name, "assembly", "index.ts");
    if (existsSync(source)) copyFileSync(source, path.join(out, name, "source.ts"));
    staged.push(name);
  }
  return staged;
}

/** Rebuilds `out` from the bundle, the worker, the programs and the stamp; throws when a bundle is missing. */
export function stageImage(
  root: string,
  out: string,
  env: Record<string, string | undefined> = process.env,
): StagedManifest {
  const src = path.join(root, "packages/infra/image");
  const bundle = path.join(root, "packages/control-plane/dist/main.js");
  // The sandbox worker: a bundled process cannot spawn itself as a worker thread, so its entry is
  // staged beside the bundle and named to the process by TABFRAME_SANDBOX_WORKER (§4.2, §9.3).
  const worker = path.join(root, "packages/control-plane/dist/node-worker.js");
  for (const file of [bundle, worker]) {
    if (!existsSync(file)) {
      throw new Error(`missing ${path.relative(root, file)}; run the bundle step first`);
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "programs"), { recursive: true });
  copyFileSync(path.join(src, "Dockerfile"), path.join(out, "Dockerfile"));
  writeFileSync(path.join(out, "package.json"), '{ "type": "module" }\n');
  copyFileSync(bundle, path.join(out, "main.js"));
  copyFileSync(worker, path.join(out, "node-worker.js"));
  writeFileSync(path.join(out, "programs", ".gitkeep"), "");
  const stamp = buildStamp(root, env);
  writeFileSync(path.join(out, "build.json"), `${JSON.stringify(stamp)}\n`);
  const programs = stagePrograms(path.join(root, "programs"), path.join(out, "programs"));
  return { out, stamp, programs, entries: readdirSync(out) };
}
