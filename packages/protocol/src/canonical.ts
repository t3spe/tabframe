/**
 * Canonical JSON: object keys sorted recursively, no whitespace, arrays in order.
 * Used wherever bytes are hashed or compared, so identical logic yields identical bytes.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string, identical in browsers and Node. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}
