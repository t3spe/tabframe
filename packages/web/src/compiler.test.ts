import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileProgram } from "../../sdk-as/scripts/build-programs.ts";
import { COMPILER_VERSION, compileInMemory, lineColumn, virtualPath } from "./compiler.ts";
import { ASC_FLAGS, assembleSources, MANDELBROT_SOURCE, shortPath } from "./editor-core.ts";

// The compiler over the virtual filesystem, exactly as the worker runs it, but under Bun: this is
// where the "a page compile is byte-identical to the build's" claim is checked.
const root = path.resolve(import.meta.dir, "../../..");
const out = path.join(root, "packages/web/dist-test/mandelbrot-ref.wasm");
let reference: Uint8Array;

beforeAll(async () => {
  await compileProgram(path.join(root, "programs/mandelbrot/assembly/index.ts"), out);
  reference = new Uint8Array(readFileSync(out));
}, 60_000);

describe("compileInMemory", () => {
  test("compiles the shipped Mandelbrot to the very bytes the build produces", async () => {
    const r = await compileInMemory(assembleSources(MANDELBROT_SOURCE), [...ASC_FLAGS]);
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.wasm?.length).toBe(reference.length);
    expect(Buffer.compare(Buffer.from(r.wasm as Uint8Array), Buffer.from(reference))).toBe(0);
    expect(r.ms).toBeGreaterThan(0);
    console.log(`[compiler.test] asc ${COMPILER_VERSION}: ${r.wasm?.length} bytes in ${r.ms} ms`);
  }, 60_000);

  test("a type error names the line in the program, and no module comes out", async () => {
    const lines = MANDELBROT_SOURCE.split("\n");
    const at = lines.findIndex((l) => l.startsWith("const TILE"));
    expect(at).toBeGreaterThan(0);
    lines.splice(at, 0, 'const broken: i32 = "not a number";');
    const r = await compileInMemory(assembleSources(lines.join("\n")), [...ASC_FLAGS]);
    expect(r.ok).toBe(false);
    expect(r.wasm).toBeNull();
    const err = r.diagnostics.find((d) => d.level === "error");
    expect(err).toBeDefined();
    if (!err) return;
    expect(err.code).toBe(2322);
    expect(shortPath(err.file ?? "")).toBe("assembly/index.ts");
    expect(err.line).toBe(at + 1);
    expect(err.column).toBeGreaterThan(0);
    expect(r.stderr).toContain("TS2322");
  }, 60_000);

  test("a missing import is a diagnostic too, not a throw", async () => {
    const src =
      'import { nope } from "@tabframe/sdk-as/assembly/index";\nexport function run(): void { nope(); }\n';
    const r = await compileInMemory(assembleSources(src), [...ASC_FLAGS]);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.level === "error")).toBe(true);
  }, 60_000);
});

describe("lineColumn", () => {
  test("1-based, from a character offset", () => {
    const text = "ab\ncde\n\nf";
    expect(lineColumn(text, 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn(text, 1)).toEqual({ line: 1, column: 2 });
    expect(lineColumn(text, 3)).toEqual({ line: 2, column: 1 });
    expect(lineColumn(text, 5)).toEqual({ line: 2, column: 3 });
    expect(lineColumn(text, 8)).toEqual({ line: 4, column: 1 });
    expect(lineColumn(text, 99)).toEqual({ line: 4, column: 2 });
  });
});

describe("virtualPath", () => {
  test("joins with the base directory and strips dot segments", () => {
    expect(virtualPath("program/assembly/index.ts", ".")).toBe("program/assembly/index.ts");
    expect(virtualPath("./abi.ts", "node_modules/@tabframe/sdk-as/assembly")).toBe(
      "node_modules/@tabframe/sdk-as/assembly/abi.ts",
    );
    expect(virtualPath("../bytes.ts", "a/b")).toBe("a/bytes.ts");
    expect(virtualPath("/abs/file.ts", "base")).toBe("abs/file.ts");
    expect(virtualPath("x.ts", "")).toBe("x.ts");
  });
});
