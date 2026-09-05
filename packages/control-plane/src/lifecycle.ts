import { adoptLedger, type Clock, createLedger, type Ledger } from "@tabframe/core";
import type { StoreDriver } from "@tabframe/store";
import type { Config } from "./config.ts";
import type { CoreFleet, CoreFleetConfig } from "./cores.ts";
import type { Inflight } from "./inflight.ts";
import type { Log } from "./log.ts";
import { type DiscoveredProgram, discoverPrograms, reconcileSeed, seedPrograms } from "./seed.ts";
import type { ProcessState } from "./state.ts";

export interface LifecycleDeps {
  state: ProcessState;
  config: Config;
  clock: Clock;
  store: StoreDriver;
  /** Injected programs (tests); absent, the configured directory is scanned. */
  programs: DiscoveredProgram[] | undefined;
  /** An injected fleet (tests); absent, `coreFleet` builds the platform's when a ledger arrives. */
  cores: CoreFleet | undefined;
  coreFleet: ((config: CoreFleetConfig) => CoreFleet) | undefined;
  inflight: Inflight;
  log: Log;
}

export interface Lifecycle {
  /** Fresh or adopted, the ledger is ours from here: the role is announced and the programs seeded. */
  becomeControlPlane(base: string, adopted: Ledger | null): void;
  /** Resolves when seeding has run for the current ledger. */
  seeded(): Promise<void>;
  cores(): CoreFleet | null;
  /** The version cores launch at: the one this process runs when the platform said, else the configured one. */
  imageVersion(): string | null;
  /** Ask the platform which image version this MicroVM runs, so cores follow a rolled-back control plane. */
  learnImageVersion(microvmId: string): void;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { state, config, clock, log } = deps;
  let cores: CoreFleet | null = deps.cores ?? null;
  let runningImageVersion: string | null = null;
  let seeding: Promise<void> = Promise.resolve();

  const imageVersion = (): string | null =>
    runningImageVersion ?? (config.mode === "image" ? (config.cores?.imageVersion ?? null) : null);

  /** Cloud cores need the image, the core role, and a session URL to point the cores at. */
  function canRunCores(): boolean {
    return Boolean(deps.cores ?? (config.mode === "image" && config.cores && state.sessionUrl));
  }

  /** Seeding (design §5.6): put the shipped programs, then reconcile the ledger with what landed. */
  async function seed(target: Ledger): Promise<void> {
    const programs =
      deps.programs ?? (config.programsDir ? discoverPrograms(config.programsDir) : []);
    if (programs.length === 0) {
      log("seed", { programs: [], note: "no programs found", dir: config.programsDir });
      return;
    }
    const { seeded, rejected } = await seedPrograms(deps.store, programs);
    for (const r of rejected) log("seed-rejected", r);
    if (state.ledger !== target) return; // the ledger changed under us
    const { events, report } = reconcileSeed(target, seeded, {
      defaultProgram: config.defaultProgram,
      now: clock.now(),
    });
    for (const event of events) state.dispatch(event);
    log("seed", { ...report });
  }

  return {
    becomeControlPlane(base, adopted) {
      if (!state.identity) {
        state.assume({
          role: "control-plane",
          generation: state.generation,
          microvmId: null,
          fleetSecret: null,
          sessionUrl: state.sessionUrl,
        });
      }
      const gen = state.generation;
      let ledger: Ledger;
      if (adopted) {
        state.execute(adoptLedger(adopted, gen, clock.now()));
        adopted.meta.storeBase = base;
        ledger = adopted;
      } else {
        // The ledger's clocks start now: from zero a fresh control plane believes nobody has
        // watched it for fifty years and is born asleep.
        ledger = createLedger(gen, { storeBase: base, cloudCores: canRunCores() }, clock.now());
      }
      state.own(ledger);
      ledger.config.cloudCores = canRunCores();
      if (!cores && config.mode === "image" && config.cores && state.sessionUrl && deps.coreFleet) {
        cores = deps.coreFleet({
          imageArn: config.cores.imageArn,
          imageVersion,
          coreRoleArn: config.cores.coreRoleArn,
          region: config.region,
          sessionUrl: state.sessionUrl,
          storeBase: base,
          generation: gen,
          fleetSecret: state.fleetSecret,
        });
      }
      log("role", { role: "control-plane", generation: gen, adopted: adopted !== null });
      seeding = seed(ledger).catch((err) => log("seed-failed", { error: String(err) }));
      deps.inflight.track(seeding);
    },
    seeded: () => seeding,
    cores: () => cores,
    imageVersion,
    learnImageVersion(microvmId) {
      const fleet = cores;
      if (!fleet?.describe) return;
      deps.inflight.track(
        fleet
          .describe(microvmId)
          .then((info) => {
            runningImageVersion = info?.imageVersion ?? null;
            log("image-version", { imageVersion: runningImageVersion });
          })
          .catch((err) => log("image-version-failed", { error: String(err) })),
      );
    },
  };
}
