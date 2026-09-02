// The S3 snapshot writer (design §9.4): the ledger as gzipped JSON every few seconds when it
// changed, and on the suspend and terminate hooks; keyed by generation and time, with a `latest`
// pointer the fleet reads when the previous control plane cannot hand over itself.
import { gunzipSync, gzipSync } from "node:zlib";
import { deserializeLedger, type Ledger, serializeLedger } from "@tabframe/core";
import type { SnapshotStore } from "@tabframe/store";

export const LATEST_KEY = "latest.json.gz";

export function snapshotKey(generation: number, at: number): string {
  return `g${generation}/${new Date(at).toISOString().replace(/[:.]/g, "-")}.json.gz`;
}

export interface SnapshotStatus {
  writes: number;
  lastKey: string | null;
  lastAt: number | null;
  lastBytes: number;
  lastError: string | null;
}

export class Snapshotter {
  private readonly store: SnapshotStore;
  private last: string | null = null;
  private inFlight: Promise<unknown> | null = null;
  readonly status: SnapshotStatus = {
    writes: 0,
    lastKey: null,
    lastAt: null,
    lastBytes: 0,
    lastError: null,
  };

  constructor(store: SnapshotStore) {
    this.store = store;
  }

  /** Write when the ledger changed since the last write (or always with `force`). Serialized. */
  async write(ledger: Ledger, now: number, force = false): Promise<string | null> {
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    const json = serializeLedger(ledger);
    if (!force && json === this.last) return null;
    const key = snapshotKey(ledger.meta.generation, now);
    const gz = new Uint8Array(gzipSync(json));
    const run = (async () => {
      await this.store.write(key, gz);
      await this.store.write(LATEST_KEY, gz);
    })();
    this.inFlight = run;
    try {
      await run;
      this.last = json;
      this.status.writes += 1;
      this.status.lastKey = key;
      this.status.lastAt = now;
      this.status.lastBytes = gz.length;
      this.status.lastError = null;
      return key;
    } catch (err) {
      this.status.lastError = String(err);
      throw err;
    } finally {
      this.inFlight = null;
    }
  }

  /** Read and decode a snapshot; null when the key does not exist. Plain JSON is accepted too. */
  async read(key: string): Promise<Ledger | null> {
    const bytes = await this.store.read(key);
    if (!bytes) return null;
    const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    const json = isGzip ? gunzipSync(bytes).toString("utf8") : new TextDecoder().decode(bytes);
    return deserializeLedger(json);
  }

  /** The serialized ledger as it stands, for the private `/snapshot` route. */
  current(ledger: Ledger): string {
    return serializeLedger(ledger);
  }
}
