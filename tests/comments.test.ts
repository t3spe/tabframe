import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Comments say why; when a line came to be is history, kept in docs/implementation and in git.
// This keeps work-package tags, dates, and "used to" narration out of the source for good.
const root = path.resolve(import.meta.dir, "..");
const ROOTS = ["packages", "e2e", "programs"];
const SKIP = new Set([
  "node_modules",
  "dist",
  "dist-test",
  "image-dist",
  "cdk.out",
  "coverage",
  "test-results",
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|css|html|toml|yml)$/.test(name) && !name.endsWith(".generated.ts"))
      out.push(full);
  }
  return out;
}

const COMMENT = /^\s*(\/\/|\*|\/\*|#|<!--)/;
const HISTORY = /\(WP\d|\bWP\d+\.\d+\b|\b20\d\d-\d\d-\d\d\b|\bused to\b|\bfound by\b/;

describe("source comments", () => {
  test("carry no work-package tags, dates, or history narration", () => {
    const offenders: string[] = [];
    for (const dir of ROOTS) {
      for (const file of sources(path.join(root, dir))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (COMMENT.test(line) && HISTORY.test(line))
            offenders.push(`${path.relative(root, file)}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
