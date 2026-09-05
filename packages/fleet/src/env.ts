// The environment each fleet function is given. The stack builds a function's environment from its
// tuple and the loader reads only the tuple's keys, so a renamed or dropped variable is a compile
// error on either side; the synth test checks the templates against the same tuples.

export const SESSION_ENV = [
  "TABFRAME_POINTER_PARAM",
  "TABFRAME_STORE_BASE",
  "TABFRAME_WEB_ORIGIN",
  "TABFRAME_ROTATE_FUNCTION",
] as const;

export const ROTATE_ENV = [
  "TABFRAME_POINTER_PARAM",
  "TABFRAME_IMAGE_ARN",
  "TABFRAME_CP_ROLE_ARN",
  "TABFRAME_SESSION_URL",
  "TABFRAME_STORE_BASE",
  "TABFRAME_FLEET_SECRET_ARN",
  "TABFRAME_SNAPSHOT_BUCKET",
] as const;

export const CANARY_ENV = ["TABFRAME_WEB_ORIGIN", "TABFRAME_SESSION_URL"] as const;

/** A function's environment as the stack writes it: every key of the tuple and nothing else. */
export type EnvOf<K extends readonly string[]> = Record<K[number], string>;

/** The keys of `keys` that are set in `env`; a loader reads its function's environment through this. */
export function pick<K extends readonly string[]>(
  env: Record<string, string | undefined>,
  keys: K,
): Partial<EnvOf<K>> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<EnvOf<K>>;
}
