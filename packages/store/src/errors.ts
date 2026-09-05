export type StoreErrorKind = "network" | "http" | "timeout" | "presign";

/**
 * The store, or the path to it, failed. A node that sees one releases the task instead of
 * reporting a program fault: the program did nothing wrong, another node will run the task.
 */
export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  /** The HTTP status, for `kind: "http"`. */
  readonly status: number | undefined;

  constructor(
    kind: StoreErrorKind,
    message: string,
    details: { status?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "StoreError";
    this.kind = kind;
    this.status = details.status;
  }
}

/** The message of whatever was thrown, for wrapping into a `StoreError`. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
