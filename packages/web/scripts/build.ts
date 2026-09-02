// Bundles the browser entry points that exist and copies public/ into dist/. `--watch` rebuilds on
// change. Runs under Bun (the developer toolchain); nothing at runtime depends on it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, watch } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const src = path.join(root, "src");
const pub = path.join(root, "public");
const dist = path.join(root, "dist");
const entries = ["host.ts", "node.ts", "sandbox.ts", "editor.ts"]
  .map((f) => path.join(src, f))
  .filter(existsSync);
const watchMode = process.argv.includes("--watch");

async function build(): Promise<boolean> {
  mkdirSync(dist, { recursive: true });
  const result = await Bun.build({
    entrypoints: entries,
    outdir: dist,
    target: "browser",
    format: "esm",
    sourcemap: "linked",
    naming: "[name].js",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    return false;
  }
  for (const f of readdirSync(pub)) copyFileSync(path.join(pub, f), path.join(dist, f));
  console.log(
    `[build:web] ${entries.length} entries → ${path.relative(process.cwd(), dist)} (${new Date().toLocaleTimeString()})`,
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
]) {
  if (existsSync(dir)) watch(dir, { recursive: true }, schedule);
}
console.log("[build:web] watching for changes");
