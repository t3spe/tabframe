import type { ZodType } from "zod";
import { byteLength, canonicalStringify } from "./canonical.ts";
import { CLOSE, type CloseCode } from "./codes.ts";
import { LIMITS, PROTOCOL_VERSION } from "./limits.ts";

export type Decoded<T> = { ok: true; msg: T } | { ok: false; closeCode: CloseCode; reason: string };

export interface DecodeOptions {
  /** Reject messages stamped with any other generation. */
  expectGen?: number;
  /** Override the size cap (tests). */
  maxBytes?: number;
}

/** Serialize a message as canonical JSON, asserting the size cap. */
export function encode(msg: unknown): string {
  const text = canonicalStringify(msg);
  const bytes = byteLength(text);
  if (bytes > LIMITS.maxMessageBytes) {
    throw new Error(`message is ${bytes} bytes, cap is ${LIMITS.maxMessageBytes}`);
  }
  return text;
}

/**
 * Parse one text frame against a schema. Every failure maps to the close code the receiving
 * end should hang up with; nothing is ever half-accepted.
 */
export function decode<T>(schema: ZodType<T>, raw: unknown, opts: DecodeOptions = {}): Decoded<T> {
  if (typeof raw !== "string")
    return reject(CLOSE.invalidMessage, "binary frames are not accepted");
  const cap = opts.maxBytes ?? LIMITS.maxMessageBytes;
  if (byteLength(raw) > cap) return reject(CLOSE.invalidMessage, `message exceeds ${cap} bytes`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject(CLOSE.invalidMessage, "not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject(CLOSE.invalidMessage, "not an object");
  }
  const envelope = parsed as { v?: unknown; gen?: unknown; t?: unknown };
  if (envelope.v !== PROTOCOL_VERSION) {
    return reject(
      CLOSE.versionMismatch,
      `protocol v${String(envelope.v)}, expected v${PROTOCOL_VERSION}`,
    );
  }
  if (opts.expectGen !== undefined && envelope.gen !== opts.expectGen) {
    return reject(
      CLOSE.generationMismatch,
      `generation ${String(envelope.gen)}, expected ${opts.expectGen}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") ?? "";
    return reject(
      CLOSE.invalidMessage,
      `${String(envelope.t)}: ${first?.message ?? "invalid"}${where ? ` at ${where}` : ""}`,
    );
  }
  return { ok: true, msg: result.data };
}

function reject(
  closeCode: CloseCode,
  reason: string,
): { ok: false; closeCode: CloseCode; reason: string } {
  return { ok: false, closeCode, reason };
}
