// In-memory fakes for the fleet interfaces. Deterministic, inspectable, no timers.
import { EMPTY_POINTER, InMemoryPointerStore, type Pointer } from "../pointer.ts";
import type {
  Clock,
  Invoker,
  Logger,
  MicrovmClient,
  MicrovmInfo,
  MicrovmState,
  PortSpec,
  RuleControl,
  RunMicrovmParams,
  SecretReader,
  Sleeper,
} from "../types.ts";

export class FakeClock implements Clock {
  private t: number;
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class FakeSleeper implements Sleeper {
  readonly slept: number[] = [];
  private readonly clock: FakeClock | null;
  constructor(clock: FakeClock | null = null) {
    this.clock = clock;
  }
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.clock?.advance(ms);
  }
}

export class FakeLogger implements Logger {
  readonly lines: {
    level: string;
    message: string;
    fields: Record<string, unknown> | undefined;
  }[] = [];
  info(message: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level: "error", message, fields });
  }
}

export class FakeInvoker implements Invoker {
  readonly calls: { functionName: string; payload: unknown; mode: "async" | "sync" }[] = [];
  syncResult: unknown = { ok: true };
  async invokeAsync(functionName: string, payload: unknown): Promise<void> {
    this.calls.push({ functionName, payload, mode: "async" });
  }
  async invokeSync(functionName: string, payload: unknown): Promise<unknown> {
    this.calls.push({ functionName, payload, mode: "sync" });
    return this.syncResult;
  }
}

export class FakeRuleControl implements RuleControl {
  readonly events: { rule: string; enabled: boolean }[] = [];
  async enable(ruleName: string): Promise<void> {
    this.events.push({ rule: ruleName, enabled: true });
  }
  async disable(ruleName: string): Promise<void> {
    this.events.push({ rule: ruleName, enabled: false });
  }
}

export class FakeSecretReader implements SecretReader {
  readonly values: Record<string, string>;
  constructor(values: Record<string, string> = {}) {
    this.values = values;
  }
  async read(secretId: string): Promise<string> {
    const v = this.values[secretId];
    if (v === undefined) throw new Error(`no such secret ${secretId}`);
    return v;
  }
}

export interface FakeRun {
  params: RunMicrovmParams;
  microvmId: string;
}

/**
 * How the fake answers one `run()`: a throttle, a client token that replays a MicroVM already gone,
 * or a boot that reports PENDING for `pendingPolls` polls and then `endsIn`.
 */
export type RunPlan =
  | { throttle: true }
  | { replayTerminated: true }
  | { pendingPolls: number; endsIn: "RUNNING" | "TERMINATED" };

export class FakeMicrovmClient implements MicrovmClient {
  readonly vms = new Map<string, MicrovmInfo>();
  readonly runs: FakeRun[] = [];
  readonly terminated: string[] = [];
  readonly tokenMints: { microvmId: string; expirationInMinutes: number; ports: PortSpec[] }[] = [];
  /** Consumed one per `run()`, in order; `defaultPlan` answers once it is empty. */
  readonly plan: RunPlan[] = [];
  defaultPlan: RunPlan = { pendingPolls: 0, endsIn: "RUNNING" };
  private counter = 0;
  private readonly boots = new Map<string, { pendingPolls: number; endsIn: MicrovmState }>();

  add(info: Partial<MicrovmInfo> & { microvmId: string }): MicrovmInfo {
    const full: MicrovmInfo = {
      state: "RUNNING",
      endpoint: `${info.microvmId}.lambda-microvm.us-west-2.on.aws`,
      imageArn: "arn:aws:lambda:us-west-2:000000000000:microvm-image:tabframe",
      imageVersion: "1",
      startedAt: new Date(0),
      stateReason: null,
      ...info,
    };
    this.vms.set(full.microvmId, full);
    return full;
  }

  setState(microvmId: string, state: MicrovmState): void {
    const vm = this.vms.get(microvmId);
    if (vm) vm.state = state;
  }

  async run(params: RunMicrovmParams): Promise<MicrovmInfo> {
    const plan = this.plan.shift() ?? this.defaultPlan;
    if ("throttle" in plan) {
      const error = new Error("Rate exceeded");
      error.name = "ThrottlingException";
      throw error;
    }
    this.counter++;
    const microvmId = `mvm-${this.counter}`;
    const base = { microvmId, imageArn: params.imageArn, imageVersion: params.imageVersion ?? "1" };
    let info: MicrovmInfo;
    if ("replayTerminated" in plan) {
      info = this.add({ ...base, state: "TERMINATED" });
    } else {
      info = this.add({ ...base, state: "PENDING" });
      this.boots.set(microvmId, { pendingPolls: plan.pendingPolls, endsIn: plan.endsIn });
    }
    this.runs.push({ params, microvmId });
    return { ...info };
  }

  async get(microvmId: string): Promise<MicrovmInfo | null> {
    const vm = this.vms.get(microvmId);
    if (!vm) return null;
    const boot = this.boots.get(microvmId);
    if (boot && vm.state === "PENDING") {
      if (boot.pendingPolls <= 0) vm.state = boot.endsIn;
      else boot.pendingPolls--;
    }
    return { ...vm };
  }

  async list(imageArn?: string): Promise<MicrovmInfo[]> {
    return [...this.vms.values()]
      .filter((vm) => imageArn === undefined || vm.imageArn === imageArn)
      .map((vm) => ({ ...vm }));
  }

  async terminate(microvmId: string): Promise<void> {
    this.terminated.push(microvmId);
    this.setState(microvmId, "TERMINATED");
  }

  async suspend(microvmId: string): Promise<void> {
    this.setState(microvmId, "SUSPENDED");
  }

  async resume(microvmId: string): Promise<void> {
    this.setState(microvmId, "RUNNING");
  }

  async createAuthToken(
    microvmId: string,
    expirationInMinutes: number,
    ports: PortSpec[],
  ): Promise<string> {
    this.tokenMints.push({ microvmId, expirationInMinutes, ports });
    return `tok-${microvmId}-${this.tokenMints.length}`;
  }
}

export function pointerStoreWith(partial: Partial<Pointer>): InMemoryPointerStore {
  return new InMemoryPointerStore({ ...EMPTY_POINTER, ...partial });
}
