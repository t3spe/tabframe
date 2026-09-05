// The two canvases: the frame's surface with the scheduler's overlay drawn over the rectangles
// still open, and the task grid beneath it. Both read the state through their deps, never a global.
import type { PlaceView } from "@tabframe/protocol";
import type { ClusterState, TaskColor, TaskState } from "./cluster-state.ts";
import { isFlashing, stageTasks, taskColor } from "./selectors.ts";
import type { TileFlag, TilePainter } from "./tiles.ts";

/** Okabe–Ito, distinguishable under the common color-vision deficiencies; luminance separates them too. */
export const COLORS: Record<TaskColor, string> = {
  pending: "#3a4250",
  assigned: "#56b4e9",
  speculated: "#cc79a7",
  released: "#e69f00",
  done: "#009e73",
  verified: "#0072b2",
  mismatch: "#f0e442",
  failed: "#d55e00",
};
export const FLASH = "#ffffff";
export const SELECTED = "#6ea8ff";
export const BG = "#0b0d10";

export interface CanvasDeps {
  state(): ClusterState;
  selectedTask(): string | null;
  now(): number;
}

const key = (p: PlaceView): string => `${p.x},${p.y}`;

/** Offscreen surface at the execution's size; the visible canvas shows it at half size with overlays. */
export class CanvasPainter implements TilePainter {
  private readonly off = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly display: HTMLCanvasElement;
  private readonly dctx: CanvasRenderingContext2D;
  private readonly deps: CanvasDeps;
  private scale = 0.5;
  private raf = 0;
  /** Rectangles the dashboard refused, so the overlay keeps outlining them. */
  readonly flagged = new Map<string, { place: PlaceView; flag: TileFlag }>();

  constructor(display: HTMLCanvasElement, deps: CanvasDeps) {
    this.display = display;
    this.deps = deps;
    this.ctx = this.off.getContext("2d") as CanvasRenderingContext2D;
    this.dctx = display.getContext("2d") as CanvasRenderingContext2D;
    this.reset(2048, 1280);
  }

  reset(w: number, h: number): void {
    this.off.width = w;
    this.off.height = h;
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(0, 0, w, h);
    this.scale = Math.min(1024 / w, 640 / h, 1);
    this.display.width = Math.round(w * this.scale);
    this.display.height = Math.round(h * this.scale);
    this.flagged.clear();
    this.present();
  }

  put(place: PlaceView, rgba: Uint8ClampedArray): void {
    const pixels = rgba as Uint8ClampedArray<ArrayBuffer>;
    this.ctx.putImageData(new ImageData(pixels, place.w, place.h), place.x, place.y);
    this.flagged.delete(key(place));
    this.present();
  }

  flag(place: PlaceView, flag: TileFlag): void {
    this.flagged.set(key(place), { place, flag });
    this.present();
  }

  clear(place: PlaceView): void {
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(place.x, place.y, place.w, place.h);
    this.flagged.delete(key(place));
    this.present();
  }

  /** Draw the surface plus the scheduler's overlay; batched to one frame. */
  present(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const d = this.dctx;
    const s = this.scale;
    d.drawImage(this.off, 0, 0, this.display.width, this.display.height);
    const now = this.deps.now();
    const state = this.deps.state();
    const selected = this.deps.selectedTask();
    if (state.execution?.view !== "tiles") return;
    for (const t of stageTasks(state)) {
      if (!t.place) continue;
      const { x, y, w, h } = t.place;
      const color = taskColor(t);
      const flashing = isFlashing(t.flashAt, now);
      if (t.status !== "done") {
        d.fillStyle = COLORS[color];
        d.globalAlpha = color === "pending" ? 0.55 : 0.85;
        d.fillRect(x * s + 1, y * s + 1, w * s - 2, h * s - 2);
        d.globalAlpha = 1;
      } else if (t.verified) {
        d.fillStyle = COLORS.verified;
        d.fillRect(x * s + 2, y * s + 2, 6, 6);
      }
      if (t.contested) {
        d.strokeStyle = COLORS.mismatch;
        d.lineWidth = 2;
        d.strokeRect(x * s + 1, y * s + 1, w * s - 2, h * s - 2);
      }
      if (flashing) {
        d.strokeStyle = FLASH;
        d.lineWidth = 2;
        d.strokeRect(x * s + 1, y * s + 1, w * s - 2, h * s - 2);
      }
      if (t.taskId === selected) {
        d.strokeStyle = SELECTED;
        d.lineWidth = 3;
        d.strokeRect(x * s + 1.5, y * s + 1.5, w * s - 3, h * s - 3);
      }
    }
    for (const { place, flag } of this.flagged.values()) {
      d.strokeStyle = flag === "missing" ? "#8a94a3" : COLORS.failed;
      d.lineWidth = 3;
      d.strokeRect(place.x * s + 1.5, place.y * s + 1.5, place.w * s - 3, place.h * s - 3);
    }
  }
}

/** Grid geometry: cell size and columns for `n` cells in `width`. */
export function gridLayout(
  n: number,
  width: number,
): { cell: number; cols: number; lines: number } {
  const cell = Math.max(3, Math.min(14, Math.floor(Math.sqrt((width * 96) / Math.max(1, n)))));
  const cols = Math.max(1, Math.floor(width / cell));
  return { cell, cols, lines: Math.ceil(n / cols) };
}

/** Which cell a click at (x, y) in canvas pixels lands on, or -1 outside the cells. */
export function gridIndexAt(n: number, width: number, x: number, y: number): number {
  const { cell, cols } = gridLayout(n, width);
  const col = Math.floor(x / cell);
  const line = Math.floor(y / cell);
  if (col < 0 || col >= cols || line < 0) return -1;
  const index = line * cols + col;
  return index < n ? index : -1;
}

/** The task grid: one cell per run task of the current stage, in grid order; hidden when empty. */
export function drawGrid(
  c: HTMLCanvasElement,
  state: ClusterState,
  deps: Pick<CanvasDeps, "now" | "selectedTask">,
): void {
  const rows = stageTasks(state);
  const width = Math.max(200, Math.floor(c.clientWidth || 1024));
  const n = rows.length;
  if (n === 0) {
    c.hidden = true;
    return;
  }
  c.hidden = false;
  const { cell, cols, lines } = gridLayout(n, width);
  const height = lines * cell;
  if (c.width !== width || c.height !== height) {
    c.width = width;
    c.height = height;
  }
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = BG;
  g.fillRect(0, 0, width, height);
  const now = deps.now();
  const selected = deps.selectedTask();
  rows.forEach((t, i) => {
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * cell;
    const flashing = isFlashing(t.flashAt, now);
    g.fillStyle = flashing ? FLASH : COLORS[taskColor(t)];
    g.fillRect(x, y, cell - 1, cell - 1);
    if (t.contested && cell >= 6) {
      g.strokeStyle = COLORS.mismatch;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, cell - 2, cell - 2);
    }
    if (t.taskId === selected) {
      g.strokeStyle = SELECTED;
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, cell - 3, cell - 3);
    }
  });
}

/** The task under a click on the grid, if any. */
export function taskAtGridClick(
  c: HTMLCanvasElement,
  state: ClusterState,
  ev: MouseEvent,
): TaskState | undefined {
  const rows = stageTasks(state);
  const rect = c.getBoundingClientRect();
  const scale = c.width / Math.max(1, rect.width);
  const x = (ev.clientX - rect.left) * scale;
  const y = (ev.clientY - rect.top) * scale;
  const index = gridIndexAt(rows.length, c.width, x, y);
  return index >= 0 ? rows[index] : undefined;
}

/** The task whose tile is under a click on the frame, if any. */
export function taskAtTileClick(
  c: HTMLCanvasElement,
  state: ClusterState,
  ev: MouseEvent,
): TaskState | undefined {
  const exec = state.execution;
  if (!exec?.canvas) return undefined;
  const rect = c.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * exec.canvas.w;
  const y = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * exec.canvas.h;
  return stageTasks(state).find(
    (t) =>
      t.place &&
      x >= t.place.x &&
      x < t.place.x + t.place.w &&
      y >= t.place.y &&
      y < t.place.y + t.place.h,
  );
}
