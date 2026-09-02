import { afterEach, describe, expect, test } from "bun:test";
import {
  DisableRuleCommand,
  EnableRuleCommand,
  EventBridgeClient,
} from "@aws-sdk/client-eventbridge";
import { InvokeCommand, type InvokeCommandOutput, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { EventBridgeRuleControl, LambdaInvoker, SecretsManagerReader } from "../src/aws.ts";
import { SdkMicrovmClient, toSdkPort } from "../src/microvm-client.ts";
import { isNotFound, isThrottling, normalizeEndpoint } from "../src/types.ts";

const microvms = mockClient(LambdaMicrovmsClient);
const lambda = mockClient(LambdaClient);
const events = mockClient(EventBridgeClient);
const secrets = mockClient(SecretsManagerClient);

afterEach(() => {
  microvms.reset();
  lambda.reset();
  events.reset();
  secrets.reset();
});

describe("SdkMicrovmClient", () => {
  const client = () => new SdkMicrovmClient(new LambdaMicrovmsClient({}));

  test("run maps params to the SDK input and the response to MicrovmInfo", async () => {
    microvms.on(RunMicrovmCommand).resolves({
      microvmId: "mvm-1",
      state: "PENDING",
      endpoint: "https://mvm-1.lambda-microvm.us-west-2.on.aws/",
      imageArn: "arn:img",
      imageVersion: "2",
      startedAt: new Date(1000),
      maximumDurationInSeconds: 28800,
    });
    const info = await client().run({
      imageArn: "arn:img",
      imageVersion: "2",
      executionRoleArn: "arn:role",
      runHookPayload: "{}",
      ingressConnectors: ["arn:in"],
      egressConnectors: ["arn:out"],
      idlePolicy: {
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 25200,
        autoResumeEnabled: true,
      },
      maximumDurationInSeconds: 28800,
      clientToken: "tok",
    });
    expect(info).toEqual({
      microvmId: "mvm-1",
      state: "PENDING",
      endpoint: "mvm-1.lambda-microvm.us-west-2.on.aws",
      imageArn: "arn:img",
      imageVersion: "2",
      startedAt: new Date(1000),
      stateReason: null,
    });
    expect(microvms.commandCalls(RunMicrovmCommand)[0]?.args[0].input).toEqual({
      imageIdentifier: "arn:img",
      imageVersion: "2",
      executionRoleArn: "arn:role",
      runHookPayload: "{}",
      ingressNetworkConnectors: ["arn:in"],
      egressNetworkConnectors: ["arn:out"],
      idlePolicy: {
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 25200,
        autoResumeEnabled: true,
      },
      maximumDurationInSeconds: 28800,
      clientToken: "tok",
    });
  });

  test("get returns null for a missing MicroVM, maps unknown states to PENDING, and rethrows other errors", async () => {
    microvms
      .on(GetMicrovmCommand)
      .rejectsOnce(Object.assign(new Error("nf"), { name: "ResourceNotFoundException" }))
      .resolvesOnce({
        microvmId: "mvm-2",
        state: "SOMETHING_NEW" as never,
        maximumDurationInSeconds: 1,
        startedAt: undefined,
      })
      .rejectsOnce(Object.assign(new Error("boom"), { name: "InternalServerException" }));
    const c = client();
    expect(await c.get("mvm-x")).toBeNull();
    expect((await c.get("mvm-2"))?.state).toBe("PENDING");
    await expect(c.get("mvm-3")).rejects.toThrow("boom");
  });

  test("list follows pagination and maps items", async () => {
    microvms
      .on(ListMicrovmsCommand)
      .resolvesOnce({
        items: [
          {
            microvmId: "a",
            state: "RUNNING",
            imageArn: "arn:img",
            imageVersion: "1",
            startedAt: new Date(0),
          },
        ],
        nextToken: "n2",
      })
      .resolvesOnce({
        items: [
          {
            microvmId: "b",
            state: "TERMINATED",
            imageArn: "arn:img",
            imageVersion: "1",
            startedAt: new Date(0),
          },
        ],
      });
    const all = await client().list("arn:img");
    expect(all.map((m) => [m.microvmId, m.state])).toEqual([
      ["a", "RUNNING"],
      ["b", "TERMINATED"],
    ]);
    const calls = microvms.commandCalls(ListMicrovmsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.nextToken).toBe("n2");
    expect(calls[0]?.args[0].input.imageIdentifier).toBe("arn:img");
  });

  test("createAuthToken returns the proxy header value and maps port specs", async () => {
    microvms
      .on(CreateMicrovmAuthTokenCommand)
      .resolvesOnce({ authToken: { "X-aws-proxy-auth": "jwe.token" } })
      .resolvesOnce({ authToken: {} });
    const c = client();
    expect(await c.createAuthToken("mvm-1", 30, [{ port: 8080 }])).toBe("jwe.token");
    expect(microvms.commandCalls(CreateMicrovmAuthTokenCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "mvm-1",
      expirationInMinutes: 30,
      allowedPorts: [{ port: 8080 }],
    });
    await expect(c.createAuthToken("mvm-1", 30, [{ allPorts: true }])).rejects.toThrow(
      "no X-aws-proxy-auth",
    );
  });

  test("toSdkPort covers single ports, ranges, and all ports", () => {
    expect(toSdkPort({ port: 8080 })).toEqual({ port: 8080 });
    expect(toSdkPort({ range: { startPort: 8080, endPort: 8081 } })).toEqual({
      range: { startPort: 8080, endPort: 8081 },
    });
    expect(toSdkPort({ allPorts: true })).toEqual({ allPorts: {} });
  });

  test("terminate, suspend, and resume send their commands", async () => {
    microvms.on(TerminateMicrovmCommand).resolves({});
    microvms.on(SuspendMicrovmCommand).resolves({});
    microvms.on(ResumeMicrovmCommand).resolves({});
    const c = client();
    await c.terminate("a");
    await c.suspend("b");
    await c.resume("c");
    expect(microvms.commandCalls(TerminateMicrovmCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "a",
    });
    expect(microvms.commandCalls(SuspendMicrovmCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "b",
    });
    expect(microvms.commandCalls(ResumeMicrovmCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "c",
    });
  });
});

describe("LambdaInvoker", () => {
  test("invokeAsync uses the Event invocation type", async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
    await new LambdaInvoker(new LambdaClient({})).invokeAsync("fn", { reason: "heal" });
    const input = lambda.commandCalls(InvokeCommand)[0]?.args[0].input;
    expect(input?.FunctionName).toBe("fn");
    expect(input?.InvocationType).toBe("Event");
    expect(new TextDecoder().decode(input?.Payload as Uint8Array)).toBe('{"reason":"heal"}');
  });

  test("invokeSync decodes the payload, returns null when empty, and throws on function errors", async () => {
    // The SDK types Payload as a blob adapter; the mock only needs the bytes.
    const bytes = (s: string) =>
      new TextEncoder().encode(s) as unknown as NonNullable<InvokeCommandOutput["Payload"]>;
    lambda
      .on(InvokeCommand)
      .resolvesOnce({ StatusCode: 200, Payload: bytes('{"action":"launched"}') })
      .resolvesOnce({ StatusCode: 200 })
      .resolvesOnce({
        StatusCode: 200,
        FunctionError: "Unhandled",
        Payload: bytes("{}"),
      });
    const inv = new LambdaInvoker(new LambdaClient({}));
    expect(await inv.invokeSync("fn", {})).toEqual({ action: "launched" });
    expect(await inv.invokeSync("fn", {})).toBeNull();
    await expect(inv.invokeSync("fn", {})).rejects.toThrow("fn failed: Unhandled");
    expect(lambda.commandCalls(InvokeCommand)[0]?.args[0].input.InvocationType).toBe(
      "RequestResponse",
    );
  });
});

describe("EventBridgeRuleControl and SecretsManagerReader", () => {
  test("enable and disable name the rule", async () => {
    events.on(EnableRuleCommand).resolves({});
    events.on(DisableRuleCommand).resolves({});
    const rules = new EventBridgeRuleControl(new EventBridgeClient({}));
    await rules.enable("r");
    await rules.disable("r");
    expect(events.commandCalls(EnableRuleCommand)[0]?.args[0].input).toEqual({ Name: "r" });
    expect(events.commandCalls(DisableRuleCommand)[0]?.args[0].input).toEqual({ Name: "r" });
  });

  test("reads the secret string and rejects binary-only secrets", async () => {
    secrets.on(GetSecretValueCommand).resolvesOnce({ SecretString: "s" }).resolvesOnce({});
    const reader = new SecretsManagerReader(new SecretsManagerClient({}));
    expect(await reader.read("id")).toBe("s");
    await expect(reader.read("id")).rejects.toThrow("no string value");
  });
});

describe("helpers", () => {
  test("error classification and endpoint normalization", () => {
    expect(isThrottling(Object.assign(new Error(), { name: "ThrottlingException" }))).toBe(true);
    expect(isThrottling(new Error("x"))).toBe(false);
    expect(isThrottling(null)).toBe(false);
    expect(isNotFound(Object.assign(new Error(), { name: "ResourceNotFoundException" }))).toBe(
      true,
    );
    expect(isNotFound("nope")).toBe(false);
    expect(normalizeEndpoint("https://a.b.on.aws/")).toBe("a.b.on.aws");
    expect(normalizeEndpoint("a.b.on.aws")).toBe("a.b.on.aws");
  });
});
