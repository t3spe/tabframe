// Real adapters for the pointer store, Lambda invocation, EventBridge rules, the fleet secret and
// the snapshot index. Field mapping only; tested with aws-sdk-client-mock.
import {
  DisableRuleCommand,
  EnableRuleCommand,
  EventBridgeClient,
} from "@aws-sdk/client-eventbridge";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  EMPTY_POINTER,
  type Pointer,
  type PointerStore,
  parsePointer,
  serializePointer,
} from "./pointer.ts";
import {
  consoleLogger,
  type Invoker,
  type Logger,
  type RuleControl,
  type SecretReader,
  type SnapshotIndex,
} from "./types.ts";

export class SsmPointerStore implements PointerStore {
  private readonly ssm: SSMClient;
  private readonly name: string;

  constructor(name: string, ssm: SSMClient = new SSMClient({})) {
    this.name = name;
    this.ssm = ssm;
  }

  async read(): Promise<Pointer> {
    try {
      const out = await this.ssm.send(new GetParameterCommand({ Name: this.name }));
      return parsePointer(out.Parameter?.Value);
    } catch (error) {
      if ((error as { name?: unknown }).name === "ParameterNotFound") return { ...EMPTY_POINTER };
      throw error;
    }
  }

  async write(pointer: Pointer): Promise<void> {
    await this.ssm.send(
      new PutParameterCommand({
        Name: this.name,
        Value: serializePointer(pointer),
        Type: "String",
        Overwrite: true,
      }),
    );
  }
}

export class LambdaInvoker implements Invoker {
  private readonly lambda: LambdaClient;

  constructor(lambda: LambdaClient = new LambdaClient({})) {
    this.lambda = lambda;
  }

  async invokeAsync(functionName: string, payload: unknown): Promise<void> {
    await this.lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  }

  async invokeSync(functionName: string, payload: unknown): Promise<unknown> {
    const out = await this.lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
    if (out.FunctionError) {
      throw new Error(`${functionName} failed: ${out.FunctionError}`);
    }
    if (!out.Payload || out.Payload.length === 0) return null;
    return JSON.parse(new TextDecoder().decode(out.Payload));
  }
}

export class EventBridgeRuleControl implements RuleControl {
  private readonly events: EventBridgeClient;

  constructor(events: EventBridgeClient = new EventBridgeClient({})) {
    this.events = events;
  }

  async enable(ruleName: string): Promise<void> {
    await this.events.send(new EnableRuleCommand({ Name: ruleName }));
  }

  async disable(ruleName: string): Promise<void> {
    await this.events.send(new DisableRuleCommand({ Name: ruleName }));
  }
}

export class SecretsManagerReader implements SecretReader {
  private readonly secrets: SecretsManagerClient;

  constructor(secrets: SecretsManagerClient = new SecretsManagerClient({})) {
    this.secrets = secrets;
  }

  async read(secretId: string): Promise<string> {
    const out = await this.secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!out.SecretString) throw new Error(`secret ${secretId} has no string value`);
    return out.SecretString;
  }
}

/**
 * The snapshot the control plane keeps fresh as `latest.json.gz` (design §9.4). An unreadable index
 * is an answer of null, not a failed rotation: the successor then boots from an empty ledger and
 * takes the handover instead.
 */
export class S3SnapshotIndex implements SnapshotIndex {
  private readonly bucket: string;
  private readonly s3: S3Client;
  private readonly log: Logger;

  constructor(bucket: string, s3: S3Client = new S3Client({}), log: Logger = consoleLogger) {
    this.bucket = bucket;
    this.s3 = s3;
    this.log = log;
  }

  async latestKey(): Promise<string | null> {
    try {
      const out = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: "latest.json.gz", MaxKeys: 1 }),
      );
      return out.Contents?.[0]?.Key ?? null;
    } catch (error) {
      this.log.warn("rotate: could not read the latest snapshot key", { reason: String(error) });
      return null;
    }
  }
}
