// Tasks done per second over the last minute as one quiet area line, drawn at the screen's pixel
// density, with a caption that says what the picture is; the figure beside it names the rate and
// the cluster.
import { BG } from "./canvas.ts";
import type { ClusterState } from "./cluster-state.ts";
import { throughput, throughputSeries } from "./selectors.ts";

/** Round up to 1, 2, or 5 times a power of ten: a scale a reader can name. */
export function niceCeil(x: number): number {
  if (x <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** How long the scale must sit above twice the peak before it comes down. */
export const SCALE_HOLD_MS = 60_000;

/**
 * The scale rises at once to a round number above the peak and comes down only after a minute
 * below half of it, so a busy second does not make the line jump every frame.
 */
export function nextScale(
  peak: number,
  scale: number,
  scaleAt: number,
  now: number,
): { scale: number; scaleAt: number } {
  if (peak > scale) return { scale: niceCeil(peak), scaleAt: now };
  if (peak < scale / 2 && now - scaleAt > SCALE_HOLD_MS)
    return { scale: niceCeil(peak), scaleAt: now };
  return { scale, scaleAt };
}

export class ThroughputChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly figure: HTMLElement;
  private scale = 1;
  private scaleAt = 0;

  constructor(canvas: HTMLCanvasElement, figure: HTMLElement) {
    this.canvas = canvas;
    this.figure = figure;
  }

  render(state: ClusterState, now: number): void {
    const full = throughputSeries(state, now);
    const series = full.slice(0, -1); // the current second is still filling; it would always dip
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 240;
    const cssH = c.clientHeight || 36;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, cssW, cssH);
    const peak = Math.max(0, ...series);
    ({ scale: this.scale, scaleAt: this.scaleAt } = nextScale(peak, this.scale, this.scaleAt, now));
    const scale = this.scale;
    const baseY = cssH - 1.5;
    const top = 13; // room for the caption
    const y = (v: number): number => baseY - ((baseY - top) * Math.min(v, scale)) / scale;
    const stepX = cssW / Math.max(1, series.length - 1);
    g.strokeStyle = "#232a33";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, baseY + 0.5);
    g.lineTo(cssW, baseY + 0.5);
    g.stroke();
    if (series.some((v) => v > 0)) {
      g.beginPath();
      g.moveTo(0, baseY);
      for (const [i, v] of series.entries()) g.lineTo(i * stepX, y(v));
      g.lineTo((series.length - 1) * stepX, baseY);
      g.closePath();
      g.fillStyle = "rgba(110, 168, 255, 0.18)";
      g.fill();
      g.beginPath();
      for (const [i, v] of series.entries()) {
        if (i === 0) g.moveTo(0, y(v));
        else g.lineTo(i * stepX, y(v));
      }
      g.strokeStyle = "#6ea8ff";
      g.lineWidth = 1.25;
      g.lineJoin = "round";
      g.stroke();
    }
    const unit = state.execution?.view === "tiles" ? "tiles" : "tasks";
    g.fillStyle = "#7d8794";
    g.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textBaseline = "top";
    g.fillText(`last 60 s · peak ${peak} ${unit}/s · scale ${scale}`, 4, 2);
    const rate = throughput(state, now);
    this.figure.textContent = `${rate.toFixed(1)} ${unit}/s · ${state.nodes.size} nodes`;
    this.figure.dataset.rate = rate.toFixed(1);
    this.figure.dataset.nodes = String(state.nodes.size);
    this.figure.dataset.peak = String(peak);
    c.dataset.scale = String(scale);
    c.title = `${unit} done per second over the last minute, one line; the scale (${scale}/s) moves at most once a minute`;
  }
}
