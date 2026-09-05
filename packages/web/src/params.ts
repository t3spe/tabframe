// A program's params as a person types them: one parser for the editor and the launch forms.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Params are a JSON object; arrays and scalars are refused with a plain message. */
export function parseParams(text: string): Parsed<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `params are not valid JSON: ${(err as Error).message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: 'params must be a JSON object, like {"preset": 0}' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
