// The editor's pure parts (design §5.6): the virtual filesystem a compile sees, what a compile
// reports, the manifest and params the reviewer edits, the bundle a launch uploads, and the
// checks on a dropped module. No DOM, no sockets, no compiler: the UI (editor.ts) and the worker
// (compiler-worker.ts) are thin around this, and the tests run it under Bun.
import {
  BUNDLE_PATHS,
  canonicalStringify,
  type FsManifest,
  LIMITS,
  type ProgramManifest,
  programManifest,
} from "@tabframe/protocol";
import { validateModuleBytes } from "@tabframe/sandbox/validate";
import { sha256Hex } from "@tabframe/store/hash";
import {
  GUIDE_MARKDOWN,
  HELLO_MANIFEST,
  HELLO_SOURCE,
  MANDELBROT_MANIFEST,
  MANDELBROT_SOURCE,
  SDK_FILES,
  WORDCOUNT_MANIFEST,
  WORDCOUNT_SOURCE,
} from "./program-sources.generated.ts";

/** The compiler flags every program uses; must equal the SDK build's (a test pins it). */
export const ASC_FLAGS: readonly string[] = [
  "-O3",
  "--runtime",
  "stub",
  "--noAssert",
  "--maximumMemory",
  "256",
];
/** The sandbox's reference memory maximum, in 64 KiB pages. */
export const MEMORY_PAGES_MAX = 256;

/** Where the edited program lives in the virtual filesystem, and where the SDK lives. */
export const ENTRY = "program/assembly/index.ts";
export const SDK_ROOT = "node_modules/@tabframe/sdk-as";

export interface VirtualFs {
  entry: string;
  files: Record<string, string>;
}

/**
 * The files a compile sees: the edited source at the entry, the SDK under a node_modules
 * directory so `import ... from "@tabframe/sdk-as/assembly/index"` resolves the way the build's
 * `--path <program>/node_modules` does, plus the SDK's package.json for its `ascMain`.
 */
export function assembleSources(programSource: string): VirtualFs {
  const files: Record<string, string> = { [ENTRY]: programSource };
  for (const [name, text] of Object.entries(SDK_FILES))
    files[`${SDK_ROOT}/assembly/${name}`] = text;
  files[`${SDK_ROOT}/package.json`] = JSON.stringify({
    name: "@tabframe/sdk-as",
    ascMain: "assembly/index.ts",
  });
  return { entry: ENTRY, files };
}

export type DiagnosticLevel = "pedantic" | "info" | "warning" | "error";

export interface Diagnostic {
  level: DiagnosticLevel;
  code: number;
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
}

export interface CompileResult {
  ok: boolean;
  wasm: Uint8Array | null;
  diagnostics: Diagnostic[];
  stderr: string;
  ms: number;
}

/** One line per diagnostic, the way an editor's problems panel shows them. */
export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file
    ? ` — ${shortPath(d.file)}${d.line !== null ? `:${d.line}${d.column !== null ? `:${d.column}` : ""}` : ""}`
    : "";
  const code = d.code ? ` TS${d.code}` : "";
  return `${d.level.toUpperCase()}${code}: ${d.message}${where}`;
}

/** The entry reads as `assembly/index.ts`; SDK files as `sdk/<name>`. */
export function shortPath(file: string): string {
  const clean = file.replace(/^\.\//, "");
  if (clean === ENTRY || clean === `program/assembly/index`) return "assembly/index.ts";
  const sdk = `${SDK_ROOT}/assembly/`;
  if (clean.startsWith(sdk)) return `sdk/${clean.slice(sdk.length)}`;
  return clean;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Params are a JSON object; arrays and scalars are refused with a plain message. */
export function parseParams(text: string): Parsed<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `params are not valid JSON: ${(err as Error).message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: 'params must be a JSON object, like {"preset": 0}' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export interface ManifestFields {
  name: string;
  view: string;
  description: string;
  defaultParams: Record<string, unknown>;
  /** The hash of the source text the module was compiled from, when it was (WP7.6). */
  source?: string;
}

/** The manifest fields become a program manifest, validated by the protocol's schema. */
export function buildManifest(fields: ManifestFields): Parsed<ProgramManifest> {
  const r = programManifest.safeParse({
    name: fields.name.trim(),
    view: fields.view,
    persist: false,
    defaultParams: fields.defaultParams,
    ...(fields.description.trim() ? { description: fields.description.trim() } : {}),
    ...(fields.source ? { source: fields.source } : {}),
  });
  if (!r.success) {
    const issue = r.error.issues[0];
    return {
      ok: false,
      error: `manifest: ${issue ? `${issue.path.join(".") || "value"} ${issue.message}` : "invalid"}`,
    };
  }
  return { ok: true, value: r.data };
}

/** The shipped Mandelbrot manifest, for prefilling the fields. */
export function shippedManifest(): ProgramManifest {
  return programManifest.parse(JSON.parse(MANDELBROT_MANIFEST));
}

export { MANDELBROT_SOURCE };

export interface BundleInput {
  /** A file name under /in/. */
  name: string;
  bytes: Uint8Array;
}

/** An input kept by hash from the program a copy was opened from: already in the store, never re-uploaded (WP7.6). */
export interface InputRef {
  /** The bundle path, `/in/<file>`. */
  path: string;
  hash: string;
  size: number;
}

export interface Bundle {
  /** Module, manifest, inputs, the source when there is one, then the bundle manifest itself — everything a launch uploads. */
  blobs: Uint8Array[];
  files: FsManifest["files"];
  bundleBytes: Uint8Array;
  bundle: string;
  module: string;
}

/**
 * A bundle is a filesystem manifest over the fixed bundle paths, stored as a blob; the program is
 * that blob's hash. Byte for byte what the control plane's seeding produces for the same inputs
 * (packages/control-plane/src/seed.ts), so an uploaded program and a shipped one are the same
 * kind of thing.
 */
export async function buildBundle(
  module: Uint8Array,
  manifest: ProgramManifest,
  inputs: BundleInput[] = [],
  extra: { source?: Uint8Array; inputRefs?: InputRef[] } = {},
): Promise<Bundle> {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const moduleHash = await sha256Hex(module);
  const files: FsManifest["files"] = {
    [BUNDLE_PATHS.module]: { hash: moduleHash, size: module.length },
    [BUNDLE_PATHS.manifest]: { hash: await sha256Hex(manifestBytes), size: manifestBytes.length },
  };
  const blobs = [module, manifestBytes];
  for (const input of inputs) {
    files[`${BUNDLE_PATHS.inputs}${input.name}`] = {
      hash: await sha256Hex(input.bytes),
      size: input.bytes.length,
    };
    blobs.push(input.bytes);
  }
  // Inputs kept by hash are named, not uploaded; the source is uploaded, not named (the manifest
  // carries its hash, so it is not a file the program can see).
  for (const ref of extra.inputRefs ?? []) files[ref.path] = { hash: ref.hash, size: ref.size };
  if (extra.source) blobs.push(extra.source);
  const bundleManifest: FsManifest = { version: 1, files };
  const bundleBytes = new TextEncoder().encode(canonicalStringify(bundleManifest));
  blobs.push(bundleBytes);
  return { blobs, files, bundleBytes, bundle: await sha256Hex(bundleBytes), module: moduleHash };
}

export type ModuleInfo =
  | {
      ok: true;
      size: number;
      imports: string[];
      exports: string[];
      memoryMax: number | null;
    }
  | { ok: false; size: number; reason: string };

/**
 * What the sandbox will say about a module, said here first: size, well-formedness, memory
 * maximum, the import allowlist, the required exports. Used for compiled output and for the
 * drop-a-`.wasm` door alike.
 */
export function inspectModule(bytes: Uint8Array): ModuleInfo {
  const v = validateModuleBytes(bytes, { memoryPagesMax: MEMORY_PAGES_MAX });
  if (!v.ok) return { ok: false, size: bytes.length, reason: v.reason };
  return {
    ok: true,
    size: bytes.length,
    imports: WebAssembly.Module.imports(v.module).map((i) => `${i.module}.${i.name}`),
    exports: WebAssembly.Module.exports(v.module).map((e) => e.name),
    memoryMax: v.memory.max,
  };
}

/** Bytes that start with the WebAssembly magic; the door refuses anything else before validating. */
export function looksLikeWasm(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d
  );
}

export const MAX_MODULE_BYTES = LIMITS.maxModuleBytes;

/** Human-readable sizes for the panel. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- examples and the guide (WP6.6) ------------------------------------------------------------

/** A program the editor can load: its source, its manifest, and what the reader should know. */
export interface Example {
  key: "mandelbrot" | "wordcount" | "hello";
  label: string;
  source: string;
  manifest: ProgramManifest;
  /** One line under the select: what it does, and what launching it from here needs. */
  note: string;
}

export function examples(): Example[] {
  return [
    {
      key: "mandelbrot",
      label: "Mandelbrot (tiles, one stage, a follow-up)",
      source: MANDELBROT_SOURCE,
      manifest: programManifest.parse(JSON.parse(MANDELBROT_MANIFEST)),
      note: "The machine's own program: 640 tiles a frame, RGBA out, a follow-up to the next preset. Edit, compile, launch.",
    },
    {
      key: "hello",
      label: "Hello, text (one task)",
      source: HELLO_SOURCE,
      manifest: programManifest.parse(JSON.parse(HELLO_MANIFEST)),
      note: "The smallest program: one stage, one task, a line of text in the text view. Change `who` in the params.",
    },
    {
      key: "wordcount",
      label: "Word count (three stages over a file)",
      source: WORDCOUNT_SOURCE,
      manifest: programManifest.parse(JSON.parse(WORDCOUNT_MANIFEST)),
      note: "Map, reduce, merge over /in/corpus.txt. Here to read: a launch from this editor ships no inputs, so it would find no corpus — the shipped bundle carries it.",
    },
  ];
}

/** The guide's Markdown (the SDK's README), so a test can check it is the file on disk. */
/** The numbers this machine holds a program to, as one sentence (shown on the guide page). */
export function limitsSentence(): string {
  return `Limits on this machine: a module declares a memory maximum of at most ${MEMORY_PAGES_MAX} pages (${(MEMORY_PAGES_MAX * 64) / 1024} MB) and is at most ${MAX_MODULE_BYTES / (1024 * 1024)} MB; a task's inline input is at most 16 KB; an output at most 16 MB, a task's writes at most 256 files and 16 MB, its log 64 KB; a task that runs past its deadline is killed and given to another core. The views: tiles (RGBA bytes placed on a canvas), bars (the bars() payload), text (UTF-8).`;
}

export function guideMarkdown(): string {
  // The README's "Compiling" and "Tooling" sections are about the repository, not the page (WP8.1):
  // the guide stops where they start.
  const cut = GUIDE_MARKDOWN.indexOf("\n## Compiling");
  return cut === -1 ? GUIDE_MARKDOWN : GUIDE_MARKDOWN.slice(0, cut).trimEnd();
}

/**
 * Enough Markdown for the guide: headings, paragraphs, fenced code, bullet lists, inline code,
 * and bold. Everything is text nodes — nothing from the README is interpreted as HTML.
 */
export function renderGuide(markdown: string, doc: Document = document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const inline = (text: string, into: HTMLElement): void => {
    // `code`, **bold**, and the rest, in order.
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (at > last) into.append(text.slice(last, at));
      const tok = m[0];
      if (tok.startsWith("`")) {
        const code = doc.createElement("code");
        code.textContent = tok.slice(1, -1);
        into.append(code);
      } else {
        const b = doc.createElement("b");
        b.textContent = tok.slice(2, -2);
        into.append(b);
      }
      last = at + tok.length;
    }
    if (last < text.length) into.append(text.slice(last));
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) body.push(lines[i++] ?? "");
      i++; // the closing fence
      code.textContent = body.join("\n");
      pre.append(code);
      frag.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1]?.length ?? 1) + 1); // the README's h1 is the page's h2
      const h = doc.createElement(`h${level}`);
      inline(heading[2] ?? "", h);
      frag.append(h);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = doc.createElement("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        const item: string[] = [(lines[i] ?? "").replace(/^\s*[-*]\s+/, "")];
        i++;
        // A wrapped bullet continues on indented lines.
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i] ?? "") &&
          !/^\s*[-*]\s+/.test(lines[i] ?? "")
        ) {
          item.push((lines[i] ?? "").trim());
          i++;
        }
        const li = doc.createElement("li");
        inline(item.join(" "), li);
        ul.append(li);
      }
      frag.append(ul);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6}\s|```|\s*[-*]\s+)/.test(lines[i] ?? "")
    ) {
      para.push((lines[i] ?? "").trim());
      i++;
    }
    const p = doc.createElement("p");
    inline(para.join(" "), p);
    frag.append(p);
  }
  return frag;
}
