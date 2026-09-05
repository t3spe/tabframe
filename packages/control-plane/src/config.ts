/** Process configuration from the environment; the fleet secret arrives later, in the run payload. */
export type Role = "neutral" | "control-plane" | "core";
export type Mode = "local" | "image";

/** Settings both modes share. */
export interface CommonConfig {
  publicPort: number;
  privatePort: number;
  host: string;
  generation: number;
  /** Where nodes and observers fetch blobs; null means the process serves them itself. */
  storeBase: string | null;
  webDir: string | null;
  tickMs: number;
  /** Where the demo programs live: `/app/programs` in the image, `programs/` in the repo. */
  programsDir: string | null;
  /** The program the machine runs on its own while someone watches (D4). */
  defaultProgram: string;
  snapshotEveryMs: number;
  /** How often the process asks the platform which of the ledger's cores are gone (design §6.8). */
  coreCheckMs: number;
  region: string;
  sessionUrl: string | null;
}

/** A laptop process: a control plane at boot, an in-memory store, an emulated session endpoint. */
export interface LocalConfig extends CommonConfig {
  mode: "local";
  /** Serve `{off: true}` from the emulated session endpoint. */
  localOff: boolean;
  /** Boot neutral and wait for `/run`, the way the image does (`dev:rotate`). */
  localNeutral: boolean;
}

/** What the control plane needs to launch cloud cores (design §6.8). */
export interface CoresConfig {
  imageArn: string;
  imageVersion: string | null;
  coreRoleArn: string;
}

/** The MicroVM image: boots neutral and takes its role from the /run hook. */
export interface ImageConfig extends CommonConfig {
  mode: "image";
  blobBucket: string | null;
  snapshotBucket: string | null;
  /** The SSM pointer the fleet flips (design §9.2); a standby polls it, a lease expiry asks it once. */
  pointerParam: string | null;
  /** Null when the image cannot launch cores: the machine then runs on tabs alone. */
  cores: CoresConfig | null;
  /** Tests only: answer the fleet routes before any secret arrives. */
  allowOpenFleetRoutes?: boolean;
}

export type Config = LocalConfig | ImageConfig;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode = env.TABFRAME_MODE === "image" ? "image" : "local";
  const defaults = mode === "image" ? { pub: 8080, priv: 8081 } : { pub: 4080, priv: 4081 };
  const common: CommonConfig = {
    publicPort: intEnv(env.TABFRAME_PUBLIC_PORT, defaults.pub),
    privatePort: intEnv(env.TABFRAME_PRIVATE_PORT, defaults.priv),
    host: env.TABFRAME_HOST ?? (mode === "image" ? "0.0.0.0" : "127.0.0.1"),
    generation: intEnv(env.TABFRAME_GENERATION, 1),
    storeBase: env.TABFRAME_STORE_BASE ?? null,
    webDir: env.TABFRAME_WEB_DIR ?? null,
    tickMs: intEnv(env.TABFRAME_TICK_MS, 500),
    programsDir:
      env.TABFRAME_PROGRAMS_DIR === ""
        ? null
        : (env.TABFRAME_PROGRAMS_DIR ?? (mode === "image" ? "/app/programs" : "programs")),
    defaultProgram: env.TABFRAME_DEFAULT_PROGRAM ?? "mandelbrot",
    snapshotEveryMs: intEnv(env.TABFRAME_SNAPSHOT_MS, 5_000),
    coreCheckMs: intEnv(env.TABFRAME_CORE_CHECK_MS, 30_000),
    region: env.AWS_REGION ?? "us-west-2",
    sessionUrl: env.TABFRAME_SESSION_URL ?? null,
  };
  if (mode === "local") {
    return {
      ...common,
      mode,
      localOff: env.TABFRAME_LOCAL_OFF === "1",
      localNeutral: env.TABFRAME_LOCAL_NEUTRAL === "1",
    };
  }
  const imageArn = env.TABFRAME_IMAGE_ARN ?? null;
  const coreRoleArn = env.TABFRAME_CORE_ROLE_ARN ?? null;
  return {
    ...common,
    mode,
    blobBucket: env.TABFRAME_BLOB_BUCKET ?? null,
    snapshotBucket: env.TABFRAME_SNAPSHOT_BUCKET ?? null,
    pointerParam: env.TABFRAME_POINTER_PARAM ?? null,
    cores:
      imageArn && coreRoleArn
        ? { imageArn, imageVersion: env.TABFRAME_IMAGE_VERSION ?? null, coreRoleArn }
        : null,
  };
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad integer in environment: ${value}`);
  return n;
}
