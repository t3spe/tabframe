// What the demo machine is made of: its programs, the frame's geometry, the word count's numbers,
// and the pure generators for the bytes it serves. No clock, no store, no DOM.
import type { ProgramView } from "@tabframe/protocol";
import { encodeBars } from "@tabframe/protocol";

export const DEMO_CANVAS = { w: 2048, h: 1280 } as const;
export const DEMO_TILE = 64;
export const COLS = DEMO_CANVAS.w / DEMO_TILE;
export const ROWS = DEMO_CANVAS.h / DEMO_TILE;
export const DEMO_TASKS = COLS * ROWS;
/** Attempts a node runs at once. */
export const SLOTS = 2;
export const PROGRAM = "9c2f0d6b1e4a7c3f5d8b2a6e0c4f1d7b3a9e5c8f2b6d0a4e8c1f3b7d5a9e2c6f";
export const WORDCOUNT = "4d3b2a1908f7e6d5c4b3a2918070f6e5d4c3b2a1908f7e6d5c4b3a2918070f6e";
export const BROKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
/** The tile (in completion order) served under its true hash with the wrong bytes. */
export const DEMO_SCRAMBLED_AT = 150;
/** Why the demo machine sleeps after the broken program: the core's own wording (design §6.8). */
export const DEMO_SLEEP_REASON = "an hour without anyone touching the dashboard";
/** The programs the demo machine offers, in cycle order. */
export const DEMO_CYCLE = ["mandelbrot", "wordcount", "mandelbrot", "broken"] as const;
export type DemoProgram = (typeof DEMO_CYCLE)[number];

export const DEMO_PROGRAMS: ProgramView[] = [
  {
    bundle: PROGRAM,
    name: "mandelbrot",
    view: "tiles",
    description:
      "640 tiles of 64×64 per 2048×1280 frame, smooth coloring, presets advance every frame.",
    defaultParams: { preset: 0, palette: "ocean" },
    addedAt: 0,
  },
  {
    bundle: WORDCOUNT,
    name: "wordcount",
    view: "bars",
    description: "Map, reduce, merge over /in/corpus.txt; the last task emits the global top-K.",
    defaultParams: { k: 25, mapTasks: 8 },
    addedAt: 0,
  },
  {
    bundle: BROKEN,
    name: "broken",
    view: "text",
    description: "A planner that traps on its first call, so the machine can show a failure.",
    defaultParams: {},
    addedAt: 0,
  },
];

/** Moby-Dick's top words, as the real word count reports them. */
export const TOP_WORDS: Array<[string, number]> = [
  ["the", 14529],
  ["of", 6620],
  ["and", 6446],
  ["a", 4736],
  ["to", 4625],
  ["in", 4172],
  ["that", 3085],
  ["his", 2530],
  ["it", 2522],
  ["i", 2127],
  ["he", 1896],
  ["but", 1818],
  ["as", 1741],
  ["is", 1725],
  ["with", 1722],
  ["was", 1644],
  ["for", 1642],
  ["all", 1526],
  ["this", 1440],
  ["at", 1336],
  ["whale", 1240],
  ["by", 1229],
  ["not", 1168],
  ["from", 1104],
  ["so", 1067],
];

export interface Preset {
  cx: number;
  cy: number;
  scale: number;
  hue: number;
}
export const PRESETS: Preset[] = [
  { cx: -0.7453, cy: 0.1127, scale: 0.0065, hue: 0.55 },
  { cx: -0.1011, cy: 0.9563, scale: 0.03, hue: 0.05 },
  { cx: -1.25066, cy: 0.02012, scale: 0.0018, hue: 0.32 },
  { cx: 0.2825, cy: -0.0111, scale: 0.02, hue: 0.8 },
];

/** The word count's stages, in order. */
export const WC_STAGES: Array<{ name: string; count: number }> = [
  { name: "map", count: 8 },
  { name: "reduce", count: 8 },
  { name: "merge", count: 1 },
];

export const CORPUS_HEAD =
  "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.\n";

export const utf8 = new TextEncoder();

/** A small seeded generator, so a run of the demo is the same run every time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothly colored Mandelbrot tile at the preset, 64×64 RGBA. */
export function renderTile(tx: number, ty: number, preset: Preset): Uint8Array {
  const out = new Uint8Array(DEMO_TILE * DEMO_TILE * 4);
  const maxIter = 160;
  const aspect = DEMO_CANVAS.h / DEMO_CANVAS.w;
  let o = 0;
  for (let py = 0; py < DEMO_TILE; py++) {
    const y0 = preset.cy + ((ty * DEMO_TILE + py) / DEMO_CANVAS.h - 0.5) * preset.scale * aspect;
    for (let px = 0; px < DEMO_TILE; px++) {
      const x0 = preset.cx + ((tx * DEMO_TILE + px) / DEMO_CANVAS.w - 0.5) * preset.scale;
      let x = 0;
      let y = 0;
      let i = 0;
      let x2 = 0;
      let y2 = 0;
      while (x2 + y2 <= 256 && i < maxIter) {
        y = 2 * x * y + y0;
        x = x2 - y2 + x0;
        x2 = x * x;
        y2 = y * y;
        i++;
      }
      if (i >= maxIter) {
        out[o++] = 4;
        out[o++] = 6;
        out[o++] = 10;
        out[o++] = 255;
        continue;
      }
      const smooth = i + 1 - Math.log(Math.log(Math.sqrt(x2 + y2))) / Math.LN2;
      const t = Math.sqrt(smooth / maxIter);
      out[o++] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2832 * (t + preset.hue))));
      out[o++] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2832 * (t + preset.hue + 0.33))));
      out[o++] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2832 * (t + preset.hue + 0.67))));
      out[o++] = 255;
    }
  }
  return out;
}

/** Centre-out order, like the real program's planner. */
export function centreOut(): number[] {
  const idx = Array.from({ length: DEMO_TASKS }, (_, i) => i);
  const cx = (COLS - 1) / 2;
  const cy = (ROWS - 1) / 2;
  const d = (i: number) => {
    const x = i % COLS;
    const y = Math.floor(i / COLS);
    return (x - cx) ** 2 + (y - cy) ** 2;
  };
  idx.sort((a, b) => d(a) - d(b) || a - b);
  return idx;
}

/** The word count's staged outputs: partition counts as text, then the top-K as a bars payload. */
export function wordcountStage(stage: number, index: number, count: number): Uint8Array {
  if (stage === 2) return encodeBars(TOP_WORDS.map(([label, value]) => ({ label, value })));
  const words = TOP_WORDS.filter((_, i) => i % count === index);
  const lines = words.map(([w, n]) => `${w} ${stage === 0 ? Math.round(n / 8) : n}`);
  return utf8.encode(`${lines.join("\n")}\n`);
}
