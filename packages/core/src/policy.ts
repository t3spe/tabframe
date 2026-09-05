// Every cap, rate, and timeout the core decides by. The wire limits live in `@tabframe/protocol`;
// these are the control plane's own policy (design §5.5, §6.4, §6.7, §6.8, §8.3, §8.4, §9.4).
import { LIMITS, type TaskLimits } from "@tabframe/protocol";

/** Connections that never say hello or subscribe are dropped after this long. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Observers that stop pinging are dropped after this long. */
export const OBSERVER_SILENCE_MS = 5 * LIMITS.observerPingMs;
/** One node's health is announced at most this often; a flip inside the window waits for the next heartbeat. */
export const HEALTH_ANNOUNCE_MS = 2_000;

/** Results and presigns per second per node; maxInFlight keeps an honest node far below. */
export const SOLICITED_RATE = 256;
/** Presigned bytes one connection may ask for per minute: an honest core rendering all day is never closed, a flood is. */
export const PRESIGN_BYTES_PER_MIN = 64 * 1024 * 1024;
/** Presign items and bytes the whole machine may ask for per minute; a reconnect refills a connection's budget, never these. */
export const PRESIGN_ITEMS_PER_MIN_MACHINE = 12_000;
export const PRESIGN_BYTES_PER_MIN_MACHINE = 512 * 1024 * 1024;
/** Destructive controls are applied at most this often, machine-wide: a kill-half every 200 ms would relaunch cloud cores in a loop that costs money. */
export const CONTROL_COOLDOWN_MS = 2_000;
/** Launches per minute for the whole machine; the per-observer rate is `config.launchesPerMinute` (design §5.5). */
export const LAUNCHES_PER_MIN_MACHINE = 12;

/** A handover with no drain after this long is a rotation that died: the control plane carries on (design §9.4). */
export const HANDOVER_LEASE_MS = 90_000;
/** Room left for task rows once the snapshot envelope and page fields are accounted for (design §8.3). */
export const SNAPSHOT_PAGE_BUDGET = LIMITS.maxMessageBytes - 2048;

/** Programs the ledger keeps before the oldest ones nobody runs, refers to, or loops on are retired. */
export const PROGRAMS_CAP = 64;
/** A launch's params travel in every executionStarted, snapshot page, and plan assignment; bounded so one launch cannot blow the frame. */
export const PARAMS_MAX_BYTES = 4096;
export const QUEUE_CAP = 32;
/** How long a running execution waits for the store before its pending effect is issued again. */
export const STORE_RETRY_MS = 10_000;
/** Store errors on one pending effect before the execution fails: a minute of retries. */
export const STORE_ERRORS_MAX = 6;

/** The default loop backs off after a failed execution, doubling from five seconds to five minutes (D4). */
export const LOOP_BACKOFF_MIN_MS = 5_000;
export const LOOP_BACKOFF_MAX_MS = 300_000;
/** Once a person's launch has ended, the loop stays out until Start or this long without anyone touching the page (design §6.7). */
export const YIELD_IDLE_MS = 10 * 60 * 1000;
/** Ended executions kept in the ledger, and how many of those keep their tasks (design §9.4). */
export const KEEP_ENDED_EXECUTIONS = 32;
export const KEEP_ENDED_TASKS = 2;

/** Result records kept per task: every record travels in snapshots and handovers. */
export const RESULTS_PER_TASK_CAP = 16;
/** Releases a task survives before it is a program fault rather than bad luck. */
export const RELEASES_PER_TASK_CAP = 6;
/** The most compute time one report may claim, so a report cannot spend the execution's budget at will. */
export const COMPUTE_MS_REPORT_CAP = 10 * 60_000;
/** Contested rounds after which a tied vote is broken by report order rather than by another round (D7). */
export const MAX_CONTESTED_ROUNDS = 4;
/** A released task's deadline doubles per release, this many times at most and never past the report cap (design §6.4). */
export const DEADLINE_DOUBLINGS = 3;

/** The cloud-core fleet (design §6.8): how many while awake; one RunMicrovm a second is what the account allows. */
export const DESIRED_CLOUD_CORES = 2;
export const CLOUD_CORE_LAUNCH_GAP_MS = 1_000;
/** A launch asked for and not acknowledged within this long is forgotten. */
export const CLOUD_CORE_LAUNCH_ACK_MS = 60_000;
/** A core is replaced before it reaches its four-hour ceiling. */
export const CLOUD_CORE_MAX_AGE_MS = 3.5 * 60 * 60 * 1_000;
/** A core boots and says hello within seconds; one with no node for this long is not coming and is replaced. */
export const CLOUD_CORE_LINK_TIMEOUT_MS = 2 * 60 * 1_000;
/** The sleep policy (design §6.8): asleep with nobody watching, or with a dashboard nobody touches. */
export const SLEEP_AFTER_NO_OBSERVER_MS = 10 * 60 * 1_000;
export const SLEEP_AFTER_NO_INTERACTION_MS = 60 * 60 * 1_000;

/** At a drain, each client's reconnect delay is drawn from a window of this much per client, floored (design §8.4). */
export const JITTER_MS_PER_CLIENT = 30;
export const JITTER_FLOOR_MS = 2_000;

/** Task limits handed to nodes with every assignment (design §5.5). */
export const DEFAULT_TASK_LIMITS: TaskLimits = {
  maxOutputBytes: 16 * 1024 * 1024,
  maxWriteBytes: 16 * 1024 * 1024,
  maxWriteFiles: 256,
  maxLogBytes: 64 * 1024,
  memoryPagesMax: 1024,
};

/** What `createLedger` fills in for a config that does not say (design §5.5, §6.4). */
export const CONFIG_DEFAULTS = {
  computeMsCap: 60 * 60 * 1000,
  fsBytesCap: 256 * 1024 * 1024,
  taskCap: 20_000,
  launchesPerMinute: 6,
  cloudCores: false,
  deadlineFloorMs: 2_000,
  deadlineFactor: 3,
} as const;
