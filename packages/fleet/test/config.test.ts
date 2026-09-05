import { describe, expect, test } from "bun:test";
import {
  egressConnectorArn,
  ingressConnectorArn,
  loadCanaryConfig,
  loadOpsConfig,
  loadRotateConfig,
  loadSessionConfig,
} from "../src/config.ts";

describe("config", () => {
  test("connector ARNs are the AWS-managed connectors for the region", () => {
    expect(ingressConnectorArn("us-west-2")).toBe(
      "arn:aws:lambda:us-west-2:aws:network-connector:aws-network-connector:ALL_INGRESS",
    );
    expect(egressConnectorArn("eu-west-1")).toBe(
      "arn:aws:lambda:eu-west-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
    );
  });

  test("session config applies defaults and requires the store base", () => {
    const c = loadSessionConfig({ TABFRAME_STORE_BASE: "https://d1.cloudfront.net" });
    expect(c).toEqual({
      pointerParam: "/tabframe/pointer",
      storeBase: "https://d1.cloudfront.net",
      webOrigin: "*",
      rotateFunctionName: "tabframe-rotate",
      retryAfterMs: 5000,
      healCooldownMs: 10_000,
    });
    expect(() => loadSessionConfig({})).toThrow("TABFRAME_STORE_BASE");
  });

  test("rotate config reads every required variable", () => {
    const env = {
      TABFRAME_IMAGE_ARN: "arn:img",
      TABFRAME_IMAGE_VERSION: "3",
      TABFRAME_CP_ROLE_ARN: "arn:role",
      TABFRAME_SESSION_URL: "https://s/",
      TABFRAME_STORE_BASE: "https://d/",
      TABFRAME_FLEET_SECRET_ARN: "arn:secret",
      TABFRAME_SNAPSHOT_BUCKET: "snapshots",
      AWS_REGION: "us-west-2",
    };
    expect(loadRotateConfig(env)).toMatchObject({
      imageArn: "arn:img",
      imageVersion: "3",
      controlPlaneRoleArn: "arn:role",
      sessionUrl: "https://s/",
      storeBase: "https://d/",
      fleetSecretArn: "arn:secret",
      snapshotBucket: "snapshots",
      region: "us-west-2",
    });
    expect(
      loadRotateConfig({
        ...env,
        TABFRAME_IMAGE_VERSION: undefined,
        TABFRAME_SNAPSHOT_BUCKET: undefined,
        AWS_REGION: undefined,
      }),
    ).toMatchObject({
      imageVersion: null,
      snapshotBucket: null,
      region: "us-west-2",
    });
    expect(() => loadRotateConfig({ ...env, TABFRAME_CP_ROLE_ARN: undefined })).toThrow(
      "TABFRAME_CP_ROLE_ARN",
    );
  });

  test("canary config requires both addresses", () => {
    expect(
      loadCanaryConfig({ TABFRAME_WEB_ORIGIN: "https://w", TABFRAME_SESSION_URL: "https://s/" }),
    ).toEqual({ webOrigin: "https://w", sessionUrl: "https://s/" });
    expect(() => loadCanaryConfig({ TABFRAME_WEB_ORIGIN: "https://w" })).toThrow(
      "TABFRAME_SESSION_URL",
    );
    expect(() => loadCanaryConfig({ TABFRAME_SESSION_URL: "https://s/" })).toThrow(
      "TABFRAME_WEB_ORIGIN",
    );
  });

  test("ops config defaults the rule and function names", () => {
    expect(loadOpsConfig({ TABFRAME_IMAGE_ARN: "arn:img" })).toEqual({
      pointerParam: "/tabframe/pointer",
      rotateFunctionName: "tabframe-rotate",
      ruleName: "tabframe-rotate-hourly",
      imageArn: "arn:img",
    });
    expect(() => loadOpsConfig({})).toThrow("TABFRAME_IMAGE_ARN");
  });
});
