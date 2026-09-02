/** Process configuration from the environment. Nothing here is secret except the fleet secret. */
export type Role = "neutral" | "control-plane" | "core";
export type Mode = "local" | "image";

export interface Config {
  /** `local`: a laptop process that is a control plane at boot, with an in-memory store and an emulated session endpoint. `image`: boots neutral and waits for the /run hook. */
  mode: Mode;
  publicPort: number;
  privatePort: number;
  host: string;
  generation: number;
  /** Where nodes and observers fetch blobs. Locally, the process itself. */
  storeBase: string | null;
  webDir: string | null;
  /** Local mode only: serve `{off: true}` from the emulated session endpoint. */
  localOff: boolean;
  tickMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode = env.TABFRAME_MODE === "image" ? "image" : "local";
  const defaults = mode === "image" ? { pub: 8080, priv: 8081 } : { pub: 4080, priv: 4081 };
  return {
    mode,
    publicPort: intEnv(env.TABFRAME_PUBLIC_PORT, defaults.pub),
    privatePort: intEnv(env.TABFRAME_PRIVATE_PORT, defaults.priv),
    host: env.TABFRAME_HOST ?? (mode === "image" ? "0.0.0.0" : "127.0.0.1"),
    generation: intEnv(env.TABFRAME_GENERATION, 1),
    storeBase: env.TABFRAME_STORE_BASE ?? null,
    webDir: env.TABFRAME_WEB_DIR ?? null,
    localOff: env.TABFRAME_LOCAL_OFF === "1",
    tickMs: intEnv(env.TABFRAME_TICK_MS, 500),
  };
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad integer in environment: ${value}`);
  return n;
}
