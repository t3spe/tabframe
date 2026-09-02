// What an execution produced, read from the store by hash (design §5.1, §5.4): the filesystem
// manifest behind `execution.root`, the final output of a `bars` or `text` program, and previews
// of the files a person clicks on. Pure functions over bytes; the page fetches.
import {
  AbiError,
  BARS_LIMITS,
  type Bar,
  BUNDLE_PATHS,
  decodeBars,
  type FsManifest,
  fsManifest,
} from "@tabframe/protocol";

export interface FileEntry {
  path: string;
  hash: string;
  size: number;
}

/** Files grouped for the panel: the bundle's own, then each stage's outputs, then everything else. */
export interface FileGroup {
  /** `/in/`, `/out/<stage>/`, `/` for the bundle's two fixed files, or the first path segment. */
  label: string;
  files: FileEntry[];
  bytes: number;
}

export function parseManifest(bytes: Uint8Array): FsManifest {
  return fsManifest.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Entries sorted by path, with `/out/<stage>/<index>` sorted numerically inside a stage. */
export function listFiles(manifest: FsManifest): FileEntry[] {
  return Object.entries(manifest.files)
    .map(([path, f]) => ({ path, hash: f.hash, size: f.size }))
    .sort((a, b) => comparePaths(a.path, b.path));
}

export function groupFiles(files: readonly FileEntry[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    const label = groupOf(f.path);
    let g = groups.get(label);
    if (!g) {
      g = { label, files: [], bytes: 0 };
      groups.set(label, g);
    }
    g.files.push(f);
    g.bytes += f.size;
  }
  return [...groups.values()].sort(
    (a, b) => groupRank(a.label) - groupRank(b.label) || compareOut(a.label, b.label),
  );
}

function groupOf(path: string): string {
  if (path === BUNDLE_PATHS.module || path === BUNDLE_PATHS.manifest) return "/";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "out" && parts.length >= 3) return `/out/${parts[1]}/`;
  return `/${parts[0] ?? ""}/`;
}

function groupRank(label: string): number {
  if (label === "/") return 0;
  if (label === "/in/") return 1;
  if (label.startsWith("/out/")) return 2;
  return 3;
}

function compareOut(a: string, b: string): number {
  const na = Number(a.split("/")[2]);
  const nb = Number(b.split("/")[2]);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Path order that keeps `/out/0/2` before `/out/0/10`. */
export function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The output the `bars` and `text` views draw: the single result of the last stage. A last stage
 * with several outputs has no one result to show; the caller says so and lists the files instead.
 */
export function finalOutput(manifest: FsManifest): FileEntry | null {
  const outs = listFiles(manifest).filter((f) => /^\/out\/\d+\/\d+$/.test(f.path));
  if (outs.length === 0) return null;
  const last = Math.max(...outs.map((f) => Number(f.path.split("/")[2])));
  const inLast = outs.filter((f) => Number(f.path.split("/")[2]) === last);
  return inLast.length === 1 ? (inLast[0] as FileEntry) : null;
}

export type BarsResult = { ok: true; bars: Bar[] } | { ok: false; error: string };

export function readBars(bytes: Uint8Array): BarsResult {
  try {
    return { ok: true, bars: decodeBars(bytes, BARS_LIMITS) };
  } catch (err) {
    return { ok: false, error: err instanceof AbiError ? err.message : String(err) };
  }
}

/** Bars scaled to the widest, longest first, for a horizontal bar list. */
export function barRows(bars: readonly Bar[], limit = 40): Array<Bar & { fraction: number }> {
  const sorted = [...bars].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const top = sorted.slice(0, limit);
  const max = Math.max(0, ...top.map((b) => b.value));
  return top.map((b) => ({ ...b, fraction: max > 0 ? Math.max(0, b.value) / max : 0 }));
}

/** Cap on what the text view and previews render inline. */
export const TEXT_PREVIEW_BYTES = 64 * 1024;

/** UTF-8 that decodes cleanly and reads as text (no NUL, few control bytes). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) control++;
  }
  if (control > sample.length / 64) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

export function decodeText(
  bytes: Uint8Array,
  cap = TEXT_PREVIEW_BYTES,
): { text: string; truncated: boolean } {
  const slice = bytes.subarray(0, Math.min(bytes.length, cap));
  return { text: new TextDecoder().decode(slice), truncated: bytes.length > cap };
}

export type Preview =
  | { kind: "bars"; bars: Bar[] }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "manifest"; files: FileEntry[] }
  | { kind: "image"; w: number; h: number }
  | { kind: "bytes"; head: string };

/**
 * What to show for a file someone clicked: a bars payload draws, text reads, a nested manifest
 * lists, RGBA of a tile's size gets an image, anything else a hex head. The tile size is a hint
 * from the execution's placements; without one, RGBA is just bytes.
 */
export function previewOf(bytes: Uint8Array, tile: { w: number; h: number } | null): Preview {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "TFBR") {
    const r = readBars(bytes);
    if (r.ok) return { kind: "bars", bars: r.bars };
  }
  if (tile && bytes.length === tile.w * tile.h * 4) return { kind: "image", w: tile.w, h: tile.h };
  if (looksLikeText(bytes)) {
    const text = decodeText(bytes);
    if (text.text.trimStart().startsWith("{")) {
      try {
        return { kind: "manifest", files: listFiles(parseManifest(bytes)) };
      } catch {
        /* text that happens to start with a brace */
      }
    }
    return { kind: "text", ...text };
  }
  return { kind: "bytes", head: hexHead(bytes) };
}

export function hexHead(bytes: Uint8Array, n = 64): string {
  return [...bytes.subarray(0, n)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export function fmtValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
