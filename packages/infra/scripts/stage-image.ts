// `mise run build:image` ends with this: stage packages/infra/image-dist from the bundle.
import path from "node:path";
import { stageImage } from "../lib/stage-image.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const out = path.join(root, "packages/infra/image-dist");
try {
  const staged = stageImage(root, out);
  console.log(`[stage-image] ${path.relative(root, out)} ready (${staged.entries.join(", ")})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
