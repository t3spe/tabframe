// Virtual time: a heap of timers fired in time order, ties broken by creation order, so a run is
// a pure function of its inputs. Nothing in the simulation reads a real clock.
import type { Timer } from "./types.ts";

export class Timeline {
  now: number;
  fired = 0;
  private readonly heap: Timer[] = [];
  private counter = 0;

  constructor(start = 1_000_000) {
    this.now = start;
  }

  at(when: number, run: () => void): Timer {
    const timer: Timer = {
      at: Math.max(when, this.now),
      seq: ++this.counter,
      cancelled: false,
      run,
    };
    this.push(timer);
    return timer;
  }

  after(ms: number, run: () => void): Timer {
    return this.at(this.now + ms, run);
  }

  cancel(timer: Timer): void {
    timer.cancelled = true;
  }

  get pending(): number {
    return this.heap.length;
  }

  /** Fire the next live timer; false when nothing is left. */
  step(): boolean {
    for (;;) {
      const timer = this.pop();
      if (!timer) return false;
      if (timer.cancelled) continue;
      this.now = timer.at;
      this.fired += 1;
      timer.run();
      return true;
    }
  }

  private static before(a: Timer, b: Timer): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }

  private push(timer: Timer): void {
    const heap = this.heap;
    heap.push(timer);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent] as Timer;
      if (!Timeline.before(timer, p)) break;
      heap[i] = p;
      i = parent;
    }
    heap[i] = timer;
  }

  private pop(): Timer | undefined {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) return undefined;
    const last = heap.pop() as Timer;
    if (heap.length === 0) return top;
    let i = 0;
    const n = heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      let best = last;
      if (l < n && Timeline.before(heap[l] as Timer, best)) {
        m = l;
        best = heap[l] as Timer;
      }
      if (r < n && Timeline.before(heap[r] as Timer, best)) {
        m = r;
        best = heap[r] as Timer;
      }
      if (m === i) break;
      heap[i] = best;
      i = m;
    }
    heap[i] = last;
    return top;
  }
}
