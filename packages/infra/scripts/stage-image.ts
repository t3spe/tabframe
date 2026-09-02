// Assemble the MicroVM image staging directory from the real control-plane bundle:
//   packages/infra/image-dist/ = Dockerfile + package.json (ESM) + main.js + programs/
// `cdk deploy` reads it through TABFRAME_IMAGE_DIR (the committed packages/infra/image/ holds a
// placeholder so the image builds before the control plane exists).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const src = path.join(root, "packages/infra/image");
const bundle = path.join(root, "packages/control-plane/dist/main.js");
const programs = path.join(root, "programs");
const out = path.join(root, "packages/infra/image-dist");

if (!existsSync(bundle)) {
  console.error(`missing ${path.relative(root, bundle)}; run the bundle step first`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "programs"), { recursive: true });
copyFileSync(path.join(src, "Dockerfile"), path.join(out, "Dockerfile"));
writeFileSync(path.join(out, "package.json"), '{ "type": "module" }\n');
copyFileSync(bundle, path.join(out, "main.js"));
writeFileSync(path.join(out, "programs", ".gitkeep"), "");
// Compiled demo programs (WP1.5+): programs/<name>/dist/* → programs/<name>/, and the program's
// inputs (WP2.2): programs/<name>/in/* → programs/<name>/in/, which the control plane seeds as
// /in/<file> of the bundle.
if (existsSync(programs)) {
  for (const name of readdirSync(programs)) {
    const dist = path.join(programs, name, "dist");
    if (!existsSync(dist)) continue;
    mkdirSync(path.join(out, "programs", name), { recursive: true });
    for (const f of readdirSync(dist))
      copyFileSync(path.join(dist, f), path.join(out, "programs", name, f));
    const inputs = path.join(programs, name, "in");
    if (existsSync(inputs)) {
      mkdirSync(path.join(out, "programs", name, "in"), { recursive: true });
      for (const f of readdirSync(inputs))
        copyFileSync(path.join(inputs, f), path.join(out, "programs", name, "in", f));
    }
  }
}
console.log(`[stage-image] ${path.relative(root, out)} ready (${readdirSync(out).join(", ")})`);
