/** What the control plane needs from a blob store (design §7.1). */
export interface PresignItem {
  hash: string;
  size: number;
}

export interface PresignedUpload {
  hash: string;
  /** Absent when the store already holds the bytes. */
  url: string | null;
  /** Headers the client must send exactly as given (the checksum pin is among them). */
  headers: Record<string, string>;
}

export interface StoreDriver {
  /** Where anyone fetches a blob by hash. */
  urlFor(hash: string): string;
  presign(items: PresignItem[]): Promise<PresignedUpload[]>;
  exists(hash: string): Promise<boolean>;
  /**
   * Fetch a blob by hash; `maxBytes` refuses a larger one before it is read (WP8.1), so a hash an
   * untrusted party named cannot make the control plane load a gigabyte.
   */
  get(hash: string, maxBytes?: number): Promise<Uint8Array | null>;
  /** The control plane's own writes: manifests, seeded bundles. Returns the hash. */
  put(bytes: Uint8Array): Promise<string>;
}

/** Thrown by `get` when the blob is larger than the caller allows. */
export class BlobTooLarge extends Error {
  constructor(hash: string, size: number, maxBytes: number) {
    super(`blob ${hash.slice(0, 12)}… is ${size} bytes, cap ${maxBytes}`);
    this.name = "BlobTooLarge";
  }
}
