/** Process configuration from the environment. Nothing here is secret except the fleet secret. */
export type Role = "neutral" | "control-plane" | "core";
export type Mode = "local" | "image";

export interface Config {
  /** Tests only (WP8.1): an image-mode process answers the fleet routes before any secret arrives. */
  allowOpenFleetRoutes?: boolean;
  /** `local`: a laptop process that is a control plane at boot, with an in-memory store and an emulated session endpoint. `image`: boots neutral and waits for the /run hook. */
  mode: Mode;
  publicPort: number;
  privatePort: number;
  host: string;
  generation: number;
  /** Where nodes and observers fetch blobs. Locally, the process itself. */
  storeBase: string | null;
  webDir: string | null;
  /** Image mode: the blob bucket the S3 driver writes to (from the image environment). */
  blobBucket: string | null;
  /** Local mode only: serve `{off: true}` from the emulated session endpoint. */
  localOff: boolean;
  /** Local mode only: boot neutral and wait for `/run`, the way the image does (`dev:rotate`). */
  localNeutral: boolean;
  tickMs: number;
  /** Where the demo programs live: `/app/programs` in the image, `programs/` in the repo locally. */
  programsDir: string | null;
  /** The program the machine runs on its own while someone watches (D4). */
  defaultProgram: string;
  /** Image mode: the bucket the snapshotter writes to. */
  snapshotBucket: string | null;
  snapshotEveryMs: number;
  /** How often the process asks AWS which of the ledger's cores are gone (design §6.8). */
  coreCheckMs: number;
  /** Image mode: what the control plane needs to launch cloud cores (design §6.8). */
  imageArn: string | null;
  imageVersion: string | null;
  coreRoleArn: string | null;
  region: string;
  sessionUrl: string | null;
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
    blobBucket: env.TABFRAME_BLOB_BUCKET ?? null,
    localOff: env.TABFRAME_LOCAL_OFF === "1",
    localNeutral: env.TABFRAME_LOCAL_NEUTRAL === "1",
    tickMs: intEnv(env.TABFRAME_TICK_MS, 500),
    programsDir:
      env.TABFRAME_PROGRAMS_DIR === ""
        ? null
        : (env.TABFRAME_PROGRAMS_DIR ?? (mode === "image" ? "/app/programs" : "programs")),
    defaultProgram: env.TABFRAME_DEFAULT_PROGRAM ?? "mandelbrot",
    snapshotBucket: env.TABFRAME_SNAPSHOT_BUCKET ?? null,
    snapshotEveryMs: intEnv(env.TABFRAME_SNAPSHOT_MS, 5_000),
    coreCheckMs: intEnv(env.TABFRAME_CORE_CHECK_MS, 30_000),
    imageArn: env.TABFRAME_IMAGE_ARN ?? null,
    imageVersion: env.TABFRAME_IMAGE_VERSION ?? null,
    coreRoleArn: env.TABFRAME_CORE_ROLE_ARN ?? null,
    region: env.AWS_REGION ?? "us-west-2",
    sessionUrl: env.TABFRAME_SESSION_URL ?? null,
  };
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad integer in environment: ${value}`);
  return n;
}
