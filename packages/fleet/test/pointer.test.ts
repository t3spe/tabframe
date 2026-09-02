import { afterEach, describe, expect, test } from "bun:test";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { SsmPointerStore } from "../src/aws.ts";
import {
  EMPTY_POINTER,
  InMemoryPointerStore,
  parsePointer,
  serializePointer,
} from "../src/pointer.ts";

describe("parsePointer", () => {
  test("empty, malformed, or non-object input is the empty pointer", () => {
    expect(parsePointer(undefined)).toEqual(EMPTY_POINTER);
    expect(parsePointer("")).toEqual(EMPTY_POINTER);
    expect(parsePointer("{not json")).toEqual(EMPTY_POINTER);
    expect(parsePointer("42")).toEqual(EMPTY_POINTER);
    expect(parsePointer("null")).toEqual(EMPTY_POINTER);
  });

  test("the CDK initial value is off", () => {
    expect(parsePointer('{"state":"off"}')).toEqual(EMPTY_POINTER);
  });

  test("unknown states are off and bad generations are zero", () => {
    expect(parsePointer('{"state":"maybe","generation":-3}').state).toBe("off");
    expect(parsePointer('{"state":"on","generation":1.5}').generation).toBe(0);
    expect(parsePointer('{"state":"on","generation":"7"}').generation).toBe(0);
  });

  test("round-trips a full pointer", () => {
    const p = {
      state: "on" as const,
      microvmId: "mvm-1",
      endpoint: "mvm-1.on.aws",
      generation: 12,
      imageVersion: "3",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(parsePointer(serializePointer(p))).toEqual(p);
  });
});

describe("InMemoryPointerStore", () => {
  test("reads copies and records writes", async () => {
    const store = new InMemoryPointerStore();
    const first = await store.read();
    first.state = "on";
    expect((await store.read()).state).toBe("off");
    await store.write({ ...EMPTY_POINTER, state: "on", generation: 1 });
    expect(store.writes).toHaveLength(1);
    expect((await store.read()).generation).toBe(1);
  });
});

describe("SsmPointerStore", () => {
  const ssm = mockClient(SSMClient);
  afterEach(() => ssm.reset());

  test("reads and parses the parameter", async () => {
    ssm
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: '{"state":"on","microvmId":"mvm-2","generation":4}' } });
    const store = new SsmPointerStore("/tabframe/pointer", new SSMClient({}));
    const p = await store.read();
    expect(p).toMatchObject({ state: "on", microvmId: "mvm-2", generation: 4 });
    expect(ssm.commandCalls(GetParameterCommand)[0]?.args[0].input).toEqual({
      Name: "/tabframe/pointer",
    });
  });

  test("a missing parameter is the empty pointer; other errors propagate", async () => {
    const notFound = Object.assign(new Error("nf"), { name: "ParameterNotFound" });
    ssm
      .on(GetParameterCommand)
      .rejectsOnce(notFound)
      .rejectsOnce(Object.assign(new Error("boom"), { name: "InternalServerError" }));
    const store = new SsmPointerStore("/tabframe/pointer", new SSMClient({}));
    expect(await store.read()).toEqual(EMPTY_POINTER);
    await expect(store.read()).rejects.toThrow("boom");
  });

  test("writes the serialized pointer with overwrite", async () => {
    ssm.on(PutParameterCommand).resolves({ Version: 2 });
    const store = new SsmPointerStore("/tabframe/pointer", new SSMClient({}));
    const p = { ...EMPTY_POINTER, state: "on" as const, generation: 2 };
    await store.write(p);
    expect(ssm.commandCalls(PutParameterCommand)[0]?.args[0].input).toEqual({
      Name: "/tabframe/pointer",
      Value: serializePointer(p),
      Type: "String",
      Overwrite: true,
    });
  });
});
