// Bundles the browser entry points that exist and copies public/ into dist/. `--watch` rebuilds on
// change. Runs under Bun (the developer toolchain); nothing at runtime depends on it.
//
// Three bundles come out:
//   - the page: host.js, node.js, sandbox.js, editor.js — one file per entry, as before;
//   - compiler-worker.js: AssemblyScript's asc for the browser, minified, with its Node-only
//     imports left as never-taken dynamic imports and binaryen imported from a sibling file;
//   - binaryen.js: binaryen itself, copied as is (13 MB, almost all of it the compiler's own
//     WebAssembly, which no minifier shrinks), so the compiler chunk stays small and the browser
//     caches the big one separately.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { generateSources } from "./gen-sources.ts";

const root = path.resolve(import.meta.dir, "..");
const src = path.join(root, "src");
const pub = path.join(root, "public");
const dist = path.join(root, "dist");
const pageEntries = ["host.ts", "node.ts", "sandbox.ts", "editor-page.ts"]
  .map((f) => path.join(src, f))
  .filter(existsSync);
const compilerEntry = path.join(src, "compiler-worker.ts");
const watchMode = process.argv.includes("--watch");

/** asc and binaryen touch these only when they detect Node; the browser never runs those imports. */
const NODE_ONLY = [
  "fs",
  "module",
  "path",
  "url",
  "node:fs",
  "node:fs/promises",
  "node:module",
  "node:path",
  "node:url",
];

function fail(result: Awaited<ReturnType<typeof Bun.build>>): boolean {
  if (result.success) return false;
  for (const log of result.logs) console.error(String(log));
  return true;
}

async function buildPage(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: pageEntries,
    outdir: dist,
    target: "browser",
    format: "esm",
    sourcemap: "linked",
    naming: "[name].js",
  });
  return !fail(result);
}

/** binaryen resolves from asc's own directory; bun keeps it next to assemblyscript, not at the root. */
function binaryenPath(): string {
  const asc = Bun.resolveSync("assemblyscript/asc", root);
  return Bun.resolveSync("binaryen", path.dirname(asc));
}

/**
 * binaryen ships as one ESM file that already runs in browsers (its Node imports are behind a
 * runtime check), and it is almost entirely its own WebAssembly, which no minifier shrinks — a
 * bundling pass made it larger. So it is copied as is, once, and the browser caches it.
 */
function buildBinaryen(): boolean {
  const source = binaryenPath();
  const out = path.join(dist, "binaryen.js");
  const stale =
    !existsSync(out) ||
    statSync(out).size !== statSync(source).size ||
    statSync(out).mtimeMs < statSync(source).mtimeMs;
  if (stale) {
    copyFileSync(source, out);
    console.log(`[build:web] binaryen.js copied (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  }
  return true;
}

async function buildCompiler(): Promise<boolean> {
  if (!existsSync(compilerEntry)) return true;
  if (!buildBinaryen()) return false;
  const result = await Bun.build({
    entrypoints: [compilerEntry],
    target: "browser",
    format: "esm",
    minify: true,
    external: [...NODE_ONLY, "binaryen"],
  });
  if (fail(result)) return false;
  let text = await (result.outputs[0] as Blob).text();
  // The one import left bare points at the sibling asset; a module worker resolves it relative
  // to its own script URL.
  text = text
    .replace(/from\s*"binaryen"/g, 'from"./binaryen.js"')
    .replace(/import\("binaryen"\)/g, 'import("./binaryen.js")');
  if (/["']binaryen["']/.test(text.replace(/binaryen\.js/g, ""))) {
    console.error("[build:web] a bare binaryen specifier survived the rewrite");
    return false;
  }
  writeFileSync(path.join(dist, "compiler-worker.js"), text);
  return true;
}

async function build(): Promise<boolean> {
  generateSources();
  mkdirSync(dist, { recursive: true });
  const started = Date.now();
  if (!(await buildPage())) return false;
  if (!(await buildCompiler())) return false;
  for (const f of readdirSync(pub)) copyFileSync(path.join(pub, f), path.join(dist, f));
  const extra = existsSync(compilerEntry) ? " + compiler worker" : "";
  console.log(
    `[build:web] ${pageEntries.length} entries${extra} → ${path.relative(process.cwd(), dist)} in ${Date.now() - started} ms (${new Date().toLocaleTimeString()})`,
  );
  return true;
}

const ok = await build();
if (!watchMode) process.exit(ok ? 0 : 1);

let timer: ReturnType<typeof setTimeout> | null = null;
const schedule = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void build(), 150);
};
for (const dir of [
  src,
  pub,
  path.resolve(root, "../node/src"),
  path.resolve(root, "../protocol/src"),
  path.resolve(root, "../sdk-as/assembly"),
  path.resolve(root, "../../programs/mandelbrot"),
]) {
  if (existsSync(dir)) watch(dir, { recursive: true }, schedule);
}
console.log("[build:web] watching for changes");
