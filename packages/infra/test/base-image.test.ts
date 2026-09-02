import { describe, expect, test } from "bun:test";
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
} from "@aws-sdk/client-lambda-microvms";
import { mockClient } from "aws-sdk-client-mock";
import {
  pickAvailableVersion,
  resolveBaseImageVersion,
  SdkVersionLister,
} from "../lib/base-image.ts";

describe("pickAvailableVersion", () => {
  test("picks the highest AVAILABLE numeric version", () => {
    expect(
      pickAvailableVersion([
        { imageVersion: "0", status: "AVAILABLE" },
        { imageVersion: "2", status: "DEPRECATED" },
        { imageVersion: "1", status: "AVAILABLE" },
        { imageVersion: "beta", status: "AVAILABLE" },
      ]),
    ).toBe("1");
  });
  test("returns null when nothing is available", () => {
    expect(pickAvailableVersion([{ imageVersion: "1", status: "EXPIRED" }])).toBeNull();
    expect(pickAvailableVersion([])).toBeNull();
  });
});

describe("resolveBaseImageVersion with the SDK lister", () => {
  const microvms = mockClient(LambdaMicrovmsClient);
  test("follows pagination and resolves", async () => {
    microvms.reset();
    microvms
      .on(ListManagedMicrovmImageVersionsCommand)
      .resolvesOnce({
        items: [{ imageArn: "a", imageVersion: "0", status: "AVAILABLE", createdAt: new Date(0) }],
        nextToken: "t",
      })
      .resolvesOnce({
        items: [{ imageArn: "a", imageVersion: "1", status: "AVAILABLE", createdAt: new Date(0) }],
      });
    const version = await resolveBaseImageVersion(
      new SdkVersionLister(new LambdaMicrovmsClient({})),
      "arn:base",
    );
    expect(version).toBe("1");
    expect(
      microvms.commandCalls(ListManagedMicrovmImageVersionsCommand)[1]?.args[0].input.nextToken,
    ).toBe("t");
  });
  test("throws when no version is available", async () => {
    microvms.reset();
    microvms.on(ListManagedMicrovmImageVersionsCommand).resolves({ items: [] });
    await expect(
      resolveBaseImageVersion(new SdkVersionLister(new LambdaMicrovmsClient({})), "arn:base"),
    ).rejects.toThrow("no AVAILABLE version");
  });
});
