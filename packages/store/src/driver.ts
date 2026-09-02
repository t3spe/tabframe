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
  get(hash: string): Promise<Uint8Array | null>;
  /** The control plane's own writes: manifests, seeded bundles. Returns the hash. */
  put(bytes: Uint8Array): Promise<string>;
}
