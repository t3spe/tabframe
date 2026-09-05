import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BuildStamp, git, STAGED_FILES, stageImage } from "../lib/stage-image.ts";

/** A repository-shaped directory outside any git checkout. */
function fakeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "tabframe-stage-"));
  const put = (rel: string, body = rel) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  put("packages/infra/image/Dockerfile", "FROM scratch\n");
  put("packages/control-plane/dist/main.js", "// bundle\n");
  put("packages/control-plane/dist/node-worker.js", "// worker\n");
  put("programs/demo/dist/demo.wasm", "wasm");
  put("programs/demo/dist/demo.json", "{}");
  put("programs/demo/in/corpus.txt", "words");
  put("programs/demo/assembly/index.ts", "export function plan(): void {}\n");
  put("programs/unbuilt/assembly/index.ts", "// no dist: not staged\n");
  return root;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("stageImage", () => {
  test("stages exactly the files the Dockerfile copies, plus the Dockerfile itself", () => {
    const root = fakeRoot();
    roots.push(root);
    const out = path.join(root, "packages/infra/image-dist");
    const staged = stageImage(root, out, {});
    expect([...staged.entries].sort()).toEqual(
      ["Dockerfile", ...STAGED_FILES.map((f) => f.replace(/\/$/, ""))].sort(),
    );
    expect(readFileSync(path.join(out, "package.json"), "utf8")).toBe('{ "type": "module" }\n');
    expect(readFileSync(path.join(out, "main.js"), "utf8")).toBe("// bundle\n");
    expect(readFileSync(path.join(out, "node-worker.js"), "utf8")).toBe("// worker\n");
  });

  test("stages each built program with its inputs and source, and skips one without a dist", () => {
    const root = fakeRoot();
    roots.push(root);
    const out = path.join(root, "packages/infra/image-dist");
    const staged = stageImage(root, out, {});
    expect(staged.programs).toEqual(["demo"]);
    for (const f of ["demo.wasm", "demo.json", "in/corpus.txt", "source.ts"]) {
      expect(existsSync(path.join(out, "programs/demo", f))).toBe(true);
    }
    expect(existsSync(path.join(out, "programs/unbuilt"))).toBe(false);
  });

  test("the stamp is unknown outside a checkout and records an ungated deploy", () => {
    const root = fakeRoot();
    roots.push(root);
    const out = path.join(root, "packages/infra/image-dist");
    const { stamp } = stageImage(root, out, { TABFRAME_DEPLOY_UNGATED: "1" });
    expect(stamp).toEqual({ sha: "unknown", branch: "unknown", ungated: true, at: null });
    expect(JSON.parse(readFileSync(path.join(out, "build.json"), "utf8")) as BuildStamp).toEqual(
      stamp,
    );
    expect(git("rev-parse HEAD", root)).toBeNull();
  });

  test("a previous staging is replaced, not merged", () => {
    const root = fakeRoot();
    roots.push(root);
    const out = path.join(root, "packages/infra/image-dist");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "stale.js"), "");
    stageImage(root, out, {});
    expect(existsSync(path.join(out, "stale.js"))).toBe(false);
  });

  test("refuses to stage without the bundle or the worker, before touching the output", () => {
    const root = fakeRoot();
    roots.push(root);
    const out = path.join(root, "packages/infra/image-dist");
    rmSync(path.join(root, "packages/control-plane/dist/node-worker.js"));
    expect(() => stageImage(root, out, {})).toThrow(
      "missing packages/control-plane/dist/node-worker.js; run the bundle step first",
    );
    expect(existsSync(out)).toBe(false);
  });
});
