// The tiles view (design §3 step 3, §5.6): finished tiles are fetched by hash from the store,
// re-hashed before they are trusted, and painted into an offscreen canvas at the execution's size.
import type { PlaceView } from "@tabframe/protocol";
import { sha256Hex } from "@tabframe/store/hash";
import { type ClusterState, stageTasks, type TaskState } from "./state.ts";

export type TileFlag = "bad-hash" | "bad-size" | "missing";

/** Where pixels go. The page backs it with canvases; tests record calls. */
export interface TilePainter {
  /** A new frame: size the surface and clear it. */
  reset(w: number, h: number): void;
  put(place: PlaceView, rgba: Uint8ClampedArray): void;
  /** Outline a rectangle the dashboard refuses to trust. */
  flag(place: PlaceView, flag: TileFlag): void;
  /** A retracted or withdrawn tile. */
  clear(place: PlaceView): void;
}

export interface BlobSource {
  /** Bytes for a hash, or null when the store has no such blob (yet). */
  get(hash: string): Promise<Uint8Array | null>;
}

export interface TileStats {
  fetched: number;
  painted: number;
  flagged: number;
  inFlight: number;
}

interface Painted {
  hash: string;
  place: PlaceView;
  flag: TileFlag | null;
}

/**
 * Fetches from `<storeBase>/<hash>`. The browser's default cache mode (WP8.3): the CDN's
 * `immutable` header keeps a 200 for a year, while `force-cache` would have replayed a stored 404
 * for a tile asked for a moment before its upload landed. A 5xx or a network error is retried
 * three times before it is reported.
 */
export function storeSource(storeBase: string, fetchImpl: typeof fetch = fetch): BlobSource {
  const base = storeBase.replace(/\/$/, "");
  return {
    async get(hash) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
        try {
          const res = await fetchImpl(`${base}/${hash}`);
          if (res.status === 404 || res.status === 403) return null;
          if (res.status >= 500) {
            lastError = new Error(`blob ${res.status}`);
            continue;
          }
          if (!res.ok) throw new Error(`blob ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

/**
 * Keeps the painted surface in step with the cluster state: a new execution or stage clears it,
 * every settled tile is fetched once per output hash, and a retraction wipes its rectangle.
 */
export class TileView {
  private readonly source: BlobSource;
  private readonly painter: TilePainter;
  private readonly concurrency: number;
  private readonly retryAfterMs: number;
  private readonly hash: (bytes: Uint8Array) => Promise<string>;
  private readonly now: () => number;
  private frame: string | null = null;
  private readonly painted = new Map<string, Painted>();
  private readonly inFlight = new Map<string, string>();
  private readonly missingAt = new Map<string, number>();
  private queue: TaskState[] = [];
  private queued = new Set<string>();
  private generation = 0;
  readonly stats: TileStats = { fetched: 0, painted: 0, flagged: 0, inFlight: 0 };
  /** Called after any paint or flag so the page can present the surface. */
  onChange: (() => void) | null = null;

  constructor(
    source: BlobSource,
    painter: TilePainter,
    opts: {
      concurrency?: number;
      retryAfterMs?: number;
      hash?: (bytes: Uint8Array) => Promise<string>;
      now?: () => number;
    } = {},
  ) {
    this.source = source;
    this.painter = painter;
    this.concurrency = opts.concurrency ?? 6;
    this.retryAfterMs = opts.retryAfterMs ?? 2_000;
    this.hash = opts.hash ?? sha256Hex;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The frame key: execution, stage, and canvas size. Null when there is nothing to paint. */
  static frameKey(state: ClusterState): string | null {
    const exec = state.execution;
    if (exec?.view !== "tiles" || !exec.canvas) return null;
    return `${exec.executionId}/${exec.stage}/${exec.canvas.w}x${exec.canvas.h}`;
  }

  sync(state: ClusterState): void {
    const key = TileView.frameKey(state);
    if (key !== this.frame) {
      this.frame = key;
      this.generation += 1;
      this.painted.clear();
      this.inFlight.clear();
      this.missingAt.clear();
      this.queue = [];
      this.queued = new Set();
      this.stats.inFlight = 0;
      const canvas = state.execution?.canvas;
      if (key && canvas) this.painter.reset(canvas.w, canvas.h);
      this.onChange?.();
    }
    if (!key) return;
    const now = this.now();
    const live = new Set<string>();
    for (const task of stageTasks(state)) {
      if (task.status !== "done" || !task.output || !task.place) continue;
      live.add(task.taskId);
      const have = this.painted.get(task.taskId);
      if (have?.hash === task.output && (have.flag !== "missing" || this.tooSoon(task, now)))
        continue;
      if (this.inFlight.get(task.taskId) === task.output || this.queued.has(task.taskId)) continue;
      this.queue.push(task);
      this.queued.add(task.taskId);
    }
    // Retractions: a tile that was painted but is no longer settled comes off the surface.
    for (const [taskId, p] of this.painted) {
      if (live.has(taskId)) continue;
      this.painted.delete(taskId);
      this.painter.clear(p.place);
      this.onChange?.();
    }
    this.pump();
  }

  private tooSoon(task: TaskState, now: number): boolean {
    const at = this.missingAt.get(task.taskId);
    return at !== undefined && now - at < this.retryAfterMs;
  }

  private pump(): void {
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift() as TaskState;
      this.queued.delete(task.taskId);
      if (!task.output || !task.place) continue;
      this.inFlight.set(task.taskId, task.output);
      this.stats.inFlight = this.inFlight.size;
      void this.load(task, task.output, task.place, this.generation);
    }
  }

  private async load(
    task: TaskState,
    hash: string,
    place: PlaceView,
    generation: number,
  ): Promise<void> {
    let outcome: TileFlag | Uint8Array | null = null;
    try {
      const bytes = await this.source.get(hash);
      if (bytes === null) outcome = "missing";
      else if (bytes.byteLength !== place.w * place.h * 4) outcome = "bad-size";
      else if ((await this.hash(bytes)) !== hash) outcome = "bad-hash";
      else outcome = bytes;
    } catch {
      outcome = "missing";
    }
    if (generation !== this.generation) return;
    this.inFlight.delete(task.taskId);
    this.stats.inFlight = this.inFlight.size;
    this.stats.fetched += 1;
    if (outcome instanceof Uint8Array) {
      this.painter.put(
        place,
        new Uint8ClampedArray(outcome.buffer, outcome.byteOffset, outcome.byteLength),
      );
      this.painted.set(task.taskId, { hash, place, flag: null });
      this.missingAt.delete(task.taskId);
      this.stats.painted += 1;
    } else {
      this.painter.flag(place, outcome);
      this.painted.set(task.taskId, { hash, place, flag: outcome });
      if (outcome === "missing") this.missingAt.set(task.taskId, this.now());
      this.stats.flagged += 1;
    }
    this.onChange?.();
    this.pump();
  }

  /** Tiles the surface currently shows, for tests and the page's counters. */
  get flags(): Map<string, TileFlag> {
    const out = new Map<string, TileFlag>();
    for (const [id, p] of this.painted) if (p.flag) out.set(id, p.flag);
    return out;
  }

  get paintedCount(): number {
    let n = 0;
    for (const p of this.painted.values()) if (!p.flag) n++;
    return n;
  }
}
