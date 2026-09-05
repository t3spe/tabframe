/**
 * The promises the process started and has not seen settle: store, fleet and pointer calls. The
 * facade's `close()` waits for them, and tests await `idle()` instead of polling.
 */
export class Inflight {
  private readonly pending = new Set<Promise<unknown>>();

  /** Track a chain whose failures the caller already handles; one that still rejects surfaces as an uncaught exception, as an untracked chain would. */
  track(p: Promise<unknown>): void {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, (err) => {
      done();
      queueMicrotask(() => {
        throw err;
      });
    });
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolves once nothing is in flight, chains started by settling chains included. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
