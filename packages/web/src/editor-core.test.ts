import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BUNDLE_PATHS, fsManifest } from "@tabframe/protocol";
import { LocalStore } from "@tabframe/store";
import { seedPrograms } from "../../control-plane/src/seed.ts";
import { compileProgram, ASC_FLAGS as SDK_FLAGS } from "../../sdk-as/scripts/build-programs.ts";
import { GENERATED, renderSources } from "../scripts/gen-sources.ts";
import {
  ASC_FLAGS,
  assembleSources,
  buildBundle,
  buildManifest,
  ENTRY,
  fmtBytes,
  formatDiagnostic,
  inspectModule,
  looksLikeWasm,
  MANDELBROT_SOURCE,
  parseParams,
  SDK_ROOT,
  shippedManifest,
  shortPath,
} from "./editor-core.ts";

const root = path.resolve(import.meta.dir, "../../..");
const out = path.join(root, "packages/web/dist-test/mandelbrot.wasm");
let wasm: Uint8Array;

beforeAll(async () => {
  await compileProgram(path.join(root, "programs/mandelbrot/assembly/index.ts"), out);
  wasm = new Uint8Array(readFileSync(out));
}, 60_000);

describe("embedded sources", () => {
  test("the generated module matches the SDK and program files on disk", () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(renderSources());
  });
  test("the editor compiles with exactly the SDK build's flags", () => {
    expect([...ASC_FLAGS]).toEqual(SDK_FLAGS);
  });
  test("the prefilled source is the shipped Mandelbrot and its manifest parses", () => {
    expect(MANDELBROT_SOURCE).toBe(
      readFileSync(path.join(root, "programs/mandelbrot/assembly/index.ts"), "utf8"),
    );
    const m = shippedManifest();
    expect(m.name).toBe("mandelbrot");
    expect(m.view).toBe("tiles");
    expect(m.defaultParams).toEqual({ preset: 0, palette: "ocean" });
  });
});

describe("assembleSources", () => {
  test("puts the program at the entry and the SDK under node_modules with its package.json", () => {
    const fs = assembleSources("export function run(): void {}");
    expect(fs.entry).toBe(ENTRY);
    expect(fs.files[ENTRY]).toBe("export function run(): void {}");
    for (const name of ["index.ts", "abi.ts", "bytes.ts", "host.ts", "params.ts"]) {
      expect(fs.files[`${SDK_ROOT}/assembly/${name}`]).toBe(
        readFileSync(path.join(root, "packages/sdk-as/assembly", name), "utf8"),
      );
    }
    expect(JSON.parse(fs.files[`${SDK_ROOT}/package.json`] as string)).toMatchObject({
      ascMain: "assembly/index.ts",
    });
    expect(Object.keys(fs.files)).toHaveLength(7);
  });
});

describe("params and manifest", () => {
  test("params must be a JSON object; empty means none", () => {
    expect(parseParams("")).toEqual({ ok: true, value: {} });
    expect(parseParams('{"preset": 3, "palette": "ocean"}')).toEqual({
      ok: true,
      value: { preset: 3, palette: "ocean" },
    });
    expect(parseParams("[1,2]").ok).toBe(false);
    expect(parseParams("42").ok).toBe(false);
    const bad = parseParams("{preset: 1}");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("not valid JSON");
  });
  test("manifest fields go through the protocol's schema", () => {
    const ok = buildManifest({
      name: " demo ",
      view: "bars",
      description: "",
      defaultParams: { k: 1 },
    });
    expect(ok).toEqual({
      ok: true,
      value: { name: "demo", view: "bars", persist: false, defaultParams: { k: 1 } },
    });
    const withDescription = buildManifest({
      name: "demo",
      view: "text",
      description: " says hi ",
      defaultParams: {},
    });
    if (!withDescription.ok) throw new Error(withDescription.error);
    expect(withDescription.value.description).toBe("says hi");
    expect(buildManifest({ name: "", view: "tiles", description: "", defaultParams: {} }).ok).toBe(
      false,
    );
    const view = buildManifest({ name: "x", view: "3d", description: "", defaultParams: {} });
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error).toContain("view");
  });
});

describe("buildBundle", () => {
  test("produces the same bundle hash the control plane's seeding produces for the same inputs", async () => {
    const manifest = shippedManifest();
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const corpus = new TextEncoder().encode("hello hello world");
    const ours = await buildBundle(wasm, manifest, [{ name: "corpus.txt", bytes: corpus }]);
    const store = new LocalStore("http://s/blob");
    const { seeded } = await seedPrograms(store, [
      {
        name: "mandelbrot",
        dir: "n/a",
        wasm,
        manifestBytes,
        manifest,
        inputs: [{ path: "/in/corpus.txt", bytes: corpus }],
      },
    ]);
    expect(seeded[0]?.bundle).toBe(ours.bundle);
    expect(seeded[0]?.module).toBe(ours.module);
    expect(seeded[0]?.files).toEqual(ours.files);
    // Everything a launch uploads, in order: module, manifest, inputs, then the bundle itself.
    expect(ours.blobs.length).toBe(4);
    expect(ours.blobs[0]).toBe(wasm);
    expect(ours.blobs[3]).toBe(ours.bundleBytes);
    const parsed = fsManifest.parse(JSON.parse(new TextDecoder().decode(ours.bundleBytes)));
    expect(Object.keys(parsed.files).sort()).toEqual(
      ["/in/corpus.txt", BUNDLE_PATHS.manifest, BUNDLE_PATHS.module].sort(),
    );
    expect(parsed.files[BUNDLE_PATHS.module]?.size).toBe(wasm.length);
  });
  test("the bundle hash depends on every part", async () => {
    const manifest = shippedManifest();
    const a = await buildBundle(wasm, manifest);
    const b = await buildBundle(wasm, { ...manifest, name: "other" });
    const c = await buildBundle(wasm, manifest, [{ name: "x", bytes: new Uint8Array([1]) }]);
    expect(new Set([a.bundle, b.bundle, c.bundle]).size).toBe(3);
    expect(a.module).toBe(b.module);
  });
});

describe("the drop-a-.wasm door", () => {
  test("a real program passes with its imports, exports, and memory maximum", () => {
    const m = inspectModule(wasm);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.size).toBe(wasm.length);
    expect(m.imports).toEqual(["env.abort"]);
    expect([...m.exports].sort()).toEqual(["alloc", "memory", "plan", "run"]);
    expect(m.memoryMax).toBe(256);
  });
  test("junk and modules without the contract are refused with a reason", async () => {
    expect(looksLikeWasm(new TextEncoder().encode("not a module"))).toBe(false);
    expect(looksLikeWasm(wasm)).toBe(true);
    const junk = inspectModule(new TextEncoder().encode("not a module"));
    expect(junk.ok).toBe(false);
    // A valid module that is not a Tabframe program: no exports, no memory maximum.
    const empty = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const m = inspectModule(empty);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason.length).toBeGreaterThan(0);
  });
});

describe("formatting", () => {
  test("diagnostics read as one line with the short path and position", () => {
    expect(
      formatDiagnostic({
        level: "error",
        code: 2304,
        message: "Cannot find name 'x'.",
        file: ENTRY,
        line: 12,
        column: 5,
      }),
    ).toBe("ERROR TS2304: Cannot find name 'x'. — assembly/index.ts:12:5");
    expect(
      formatDiagnostic({
        level: "warning",
        code: 0,
        message: "note",
        file: null,
        line: null,
        column: null,
      }),
    ).toBe("WARNING: note");
    expect(shortPath(`${SDK_ROOT}/assembly/abi.ts`)).toBe("sdk/abi.ts");
    expect(shortPath("program/assembly/index")).toBe("assembly/index.ts");
    expect(shortPath("other/file.ts")).toBe("other/file.ts");
  });
  test("byte sizes", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(18746)).toBe("18.3 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
