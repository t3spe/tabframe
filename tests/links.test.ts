import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Every relative link and anchor in the repository's Markdown resolves. The documents are the
// contract a stranger reads first; a link into nothing is the fastest way to lose them.
const root = path.resolve(import.meta.dir, "..");

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "cdk.out" || name.startsWith("."))
      continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) markdownFiles(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function anchors(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slug(m[1] ?? "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const files = markdownFiles(root);

describe("markdown links", () => {
  test("every relative link points at a file that exists, and every anchor at a heading", () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Links in fenced code are examples, not links.
      const prose = text.replace(/```[\s\S]*?```/g, "");
      for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1] ?? "";
        if (/^(https?:|mailto:|data:)/.test(target)) continue;
        const [pathPart, anchor] = target.split("#");
        const resolved = pathPart
          ? path.resolve(path.dirname(file), decodeURIComponent(pathPart))
          : file;
        if (!existsSync(resolved)) {
          broken.push(`${path.relative(root, file)}: ${target} (missing)`);
          continue;
        }
        if (anchor && resolved.endsWith(".md")) {
          const heads = anchors(readFileSync(resolved, "utf8"));
          if (!heads.has(anchor.toLowerCase()))
            broken.push(`${path.relative(root, file)}: ${target} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("the documents index and the program READMEs exist", () => {
    for (const f of [
      "docs/README.md",
      "programs/README.md",
      "programs/mandelbrot/README.md",
      "programs/wordcount/README.md",
      "programs/tinygpt/README.md",
      "e2e/README.md",
    ]) {
      expect(existsSync(path.join(root, f))).toBe(true);
    }
  });
});
