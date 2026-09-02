// Thin adapter from the MicrovmClient interface to @aws-sdk/client-lambda-microvms.
// No logic lives here beyond field mapping; it is tested with aws-sdk-client-mock.
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  type GetMicrovmCommandOutput,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  type MicrovmItem,
  type PortSpecification,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  isNotFound,
  type MicrovmClient,
  type MicrovmInfo,
  type MicrovmState,
  normalizeEndpoint,
  type PortSpec,
  type RunMicrovmParams,
} from "./types.ts";

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "PENDING",
  "RUNNING",
  "SUSPENDED",
  "SUSPENDING",
  "TERMINATED",
  "TERMINATING",
]);

function toState(state: string | undefined): MicrovmState {
  // An unknown state is treated as pending: not serving, not gone, poll again.
  return state !== undefined && KNOWN_STATES.has(state) ? (state as MicrovmState) : "PENDING";
}

function fromDetail(out: GetMicrovmCommandOutput): MicrovmInfo {
  return {
    microvmId: out.microvmId ?? "",
    state: toState(out.state),
    endpoint: out.endpoint ? normalizeEndpoint(out.endpoint) : null,
    imageArn: out.imageArn ?? null,
    imageVersion: out.imageVersion ?? null,
    startedAt: out.startedAt ?? null,
    stateReason: out.stateReason ?? null,
  };
}

function fromItem(item: MicrovmItem): MicrovmInfo {
  return {
    microvmId: item.microvmId ?? "",
    state: toState(item.state),
    endpoint: null,
    imageArn: item.imageArn ?? null,
    imageVersion: item.imageVersion ?? null,
    startedAt: item.startedAt ?? null,
    stateReason: null,
  };
}

export function toSdkPort(spec: PortSpec): PortSpecification {
  if ("allPorts" in spec) return { allPorts: {} };
  if ("range" in spec)
    return { range: { startPort: spec.range.startPort, endPort: spec.range.endPort } };
  return { port: spec.port };
}

export class SdkMicrovmClient implements MicrovmClient {
  private readonly client: LambdaMicrovmsClient;

  constructor(client: LambdaMicrovmsClient = new LambdaMicrovmsClient({})) {
    this.client = client;
  }

  async run(params: RunMicrovmParams): Promise<MicrovmInfo> {
    const out = await this.client.send(
      new RunMicrovmCommand({
        imageIdentifier: params.imageArn,
        imageVersion: params.imageVersion ?? undefined,
        executionRoleArn: params.executionRoleArn,
        runHookPayload: params.runHookPayload,
        ingressNetworkConnectors: params.ingressConnectors,
        egressNetworkConnectors: params.egressConnectors,
        idlePolicy: params.idlePolicy ?? undefined,
        maximumDurationInSeconds: params.maximumDurationInSeconds,
        clientToken: params.clientToken ?? undefined,
      }),
    );
    return fromDetail(out);
  }

  async get(microvmId: string): Promise<MicrovmInfo | null> {
    try {
      const out = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      return fromDetail(out);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async list(imageArn?: string): Promise<MicrovmInfo[]> {
    const items: MicrovmInfo[] = [];
    let nextToken: string | undefined;
    do {
      const out = await this.client.send(
        new ListMicrovmsCommand({ imageIdentifier: imageArn, nextToken, maxResults: 50 }),
      );
      for (const item of out.items ?? []) items.push(fromItem(item));
      nextToken = out.nextToken;
    } while (nextToken);
    return items;
  }

  async terminate(microvmId: string): Promise<void> {
    await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  async suspend(microvmId: string): Promise<void> {
    await this.client.send(new SuspendMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  async resume(microvmId: string): Promise<void> {
    await this.client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  async createAuthToken(
    microvmId: string,
    expirationInMinutes: number,
    ports: PortSpec[],
  ): Promise<string> {
    const out = await this.client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: microvmId,
        expirationInMinutes,
        allowedPorts: ports.map(toSdkPort),
      }),
    );
    const token = out.authToken?.["X-aws-proxy-auth"];
    if (!token) throw new Error("CreateMicrovmAuthToken returned no X-aws-proxy-auth value");
    return token;
  }
}
