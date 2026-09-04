import { randomBytes } from "node:crypto";
// Launching and retiring cloud cores (design §6.8). The control plane holds the only role allowed
// to pass the core role, so this lives in the process rather than the fleet functions; the core
// decides how many there should be, this decides what to say to AWS.
import { egressConnectorArn, ingressConnectorArn } from "@tabframe/fleet/config";
import { SdkMicrovmClient } from "@tabframe/fleet/microvm-client";
import type { MicrovmClient, MicrovmInfo } from "@tabframe/fleet/types";
import { SERVING_STATES } from "@tabframe/fleet/types";

/** A core's ceiling: shorter than the control plane's, as a cost fuse (design §9.2). */
export const CORE_MAX_DURATION_SECONDS = 4 * 60 * 60;

export interface CoreFleetConfig {
  imageArn: string;
  imageVersion: string | null;
  coreRoleArn: string;
  region: string;
  sessionUrl: string;
  storeBase: string;
  generation: number;
  fleetSecret: string | null;
}

export interface CoreFleet {
  launch(): Promise<{ microvmId: string; token: string }>;
  terminate(microvmId: string): Promise<void>;
  /** What the platform says about one MicroVM — the control plane asks about itself (WP8.3). */
  describe?(microvmId: string): Promise<MicrovmInfo | null>;
  /** Which of these MicroVMs are no longer serving, so the ledger can forget them. */
  gone(microvmIds: string[]): Promise<string[]>;
}

/** The payload that turns a neutral image into a core (design §9.3). */
export function corePayload(config: CoreFleetConfig, coreToken: string): string {
  return JSON.stringify({
    role: "core",
    generation: config.generation,
    snapshotKey: null,
    sessionUrl: config.sessionUrl,
    storeBase: config.storeBase,
    // A core runs untrusted programs and gates no fleet route: it gets no fleet secret (WP8.2).
    fleetSecret: null,
    coreToken,
  });
}

/** A fresh core token (WP8.2): the control plane remembers it and the core's hello shows it. */
export function newCoreToken(): string {
  return randomBytes(16).toString("hex");
}

export function createCoreFleet(config: CoreFleetConfig, client?: MicrovmClient): CoreFleet {
  const microvms = client ?? new SdkMicrovmClient();
  let counter = 0;
  return {
    async launch(): Promise<{ microvmId: string; token: string }> {
      const token = newCoreToken();
      const info: MicrovmInfo = await microvms.run({
        imageArn: config.imageArn,
        imageVersion: config.imageVersion,
        executionRoleArn: config.coreRoleArn,
        runHookPayload: corePayload(config, token),
        // A core dials out to the control plane; nothing dials in to it.
        ingressConnectors: [],
        egressConnectors: [egressConnectorArn(config.region)],
        idlePolicy: null,
        maximumDurationInSeconds: CORE_MAX_DURATION_SECONDS,
        clientToken: `tabframe-core-g${config.generation}-${Date.now()}-${counter++}`,
      });
      return { microvmId: info.microvmId, token };
    },
    async terminate(microvmId: string): Promise<void> {
      await microvms.terminate(microvmId);
    },
    async describe(microvmId: string): Promise<MicrovmInfo | null> {
      return microvms.get(microvmId);
    },
    async gone(microvmIds: string[]): Promise<string[]> {
      const dead: string[] = [];
      for (const id of microvmIds) {
        const info = await microvms.get(id);
        if (!info || !SERVING_STATES.has(info.state)) dead.push(id);
      }
      return dead;
    },
  };
}

export { ingressConnectorArn };
