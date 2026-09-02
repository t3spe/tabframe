import type { FsManifest, TaskLimits } from "@tabframe/protocol";
import { fsPath } from "@tabframe/protocol";
import type { BlobReader } from "./types.ts";

/** Return codes of the tf imports (design §5.3, pinned here; see the WP doc). */
export const RC = { notFound: -1, badArgs: -2, capExceeded: -3 } as const;

const encoder = new TextEncoder();

/**
 * One task's view of its execution's filesystem (design §5.4): the stage manifest, this task's
 * own writes layered on top, and a log. Bytes come from the reader; nothing here touches I/O
 * asynchronously, so the glue can call it from inside a WebAssembly import.
 */
export class FsView {
  readonly writes = new Map<string, Uint8Array>();
  private writeBytes = 0;
  private logParts: string[] = [];
  private logBytes = 0;
  logTruncated = false;
  private readonly manifest: FsManifest;
  private readonly reader: BlobReader;
  private readonly limits: TaskLimits;

  constructor(manifest: FsManifest, reader: BlobReader, limits: TaskLimits) {
    this.manifest = manifest;
    this.reader = reader;
    this.limits = limits;
  }

  /** Size in bytes, or notFound. */
  stat(path: string): number {
    const own = this.writes.get(path);
    if (own) return own.length;
    const entry = this.manifest.files[path];
    return entry ? entry.size : RC.notFound;
  }

  /** Bytes [offset, offset+len) of a file (possibly shorter at EOF), or a negative code. */
  read(path: string, offset: number, len: number): Uint8Array | number {
    if (!Number.isInteger(offset) || !Number.isInteger(len) || offset < 0 || len < 0) {
      return RC.badArgs;
    }
    const bytes = this.bytesFor(path);
    if (!bytes) return RC.notFound;
    if (offset >= bytes.length) return new Uint8Array(0);
    return bytes.subarray(offset, Math.min(bytes.length, offset + len));
  }

  /** Every path under a prefix, own writes included, sorted, joined by newlines. */
  list(prefix: string): string {
    const paths = new Set<string>();
    for (const p of Object.keys(this.manifest.files)) if (p.startsWith(prefix)) paths.add(p);
    for (const p of this.writes.keys()) if (p.startsWith(prefix)) paths.add(p);
    return [...paths].sort().join("\n");
  }

  /** Replace a whole file; visible to later reads in this task, committed with the result. */
  write(path: string, bytes: Uint8Array): number {
    if (!fsPath.safeParse(path).success) return RC.badArgs;
    const previous = this.writes.get(path)?.length ?? 0;
    if (!this.writes.has(path) && this.writes.size >= this.limits.maxWriteFiles) {
      return RC.capExceeded;
    }
    if (this.writeBytes - previous + bytes.length > this.limits.maxWriteBytes) {
      return RC.capExceeded;
    }
    this.writes.set(path, bytes);
    this.writeBytes += bytes.length - previous;
    return 0;
  }

  /** Append to the log; truncated silently at the cap. */
  appendLog(text: string): void {
    if (this.logTruncated) return;
    const size = encoder.encode(text).length;
    if (this.logBytes + size > this.limits.maxLogBytes) {
      this.logTruncated = true;
      this.logParts.push("\n[log truncated]");
      return;
    }
    this.logParts.push(text);
    this.logBytes += size;
  }

  get log(): string {
    return this.logParts.join("");
  }

  private bytesFor(path: string): Uint8Array | null {
    const own = this.writes.get(path);
    if (own) return own;
    const entry = this.manifest.files[path];
    if (!entry) return null;
    return this.reader.read(entry.hash, 0, Number.POSITIVE_INFINITY);
  }
}
