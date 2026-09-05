import { describe, expect, test } from "bun:test";
import { budgetDecision, loadAppConfig, stagingDir } from "../lib/app-config.ts";

const repoRoot = "/repo";
const nothing = () => false;
const staged = (p: string) => p.startsWith("/repo/packages/infra/image-dist/");

describe("budgetDecision", () => {
  test("an address wins", () => {
    expect(budgetDecision({ TABFRAME_BUDGET_EMAIL: "ops@example.invalid" }, "deploy")).toEqual({
      kind: "email",
      email: "ops@example.invalid",
    });
  });
  test("declining on purpose holds for a synth and a deploy alike", () => {
    expect(budgetDecision({ TABFRAME_NO_BUDGET: "1" }, "synth")).toEqual({
      kind: "none",
      reason: "declined",
    });
    expect(budgetDecision({ TABFRAME_NO_BUDGET: "1" }, "deploy")).toEqual({
      kind: "none",
      reason: "declined",
    });
  });
  test("the placeholder exempts a synth, never a deploy", () => {
    expect(budgetDecision({ TABFRAME_IMAGE_PLACEHOLDER: "1" }, "synth")).toEqual({
      kind: "none",
      reason: "placeholder",
    });
    expect(budgetDecision({ TABFRAME_IMAGE_PLACEHOLDER: "1" }, "deploy")).toEqual({
      kind: "missing",
    });
  });
  test("nothing set is a missing address", () => {
    expect(budgetDecision({}, "synth")).toEqual({ kind: "missing" });
  });
});

describe("stagingDir", () => {
  test("the staged image, from the default directory or TABFRAME_IMAGE_DIR", () => {
    expect(stagingDir({}, repoRoot, staged)).toBe("/repo/packages/infra/image-dist");
    expect(
      stagingDir({ TABFRAME_IMAGE_DIR: "/elsewhere" }, repoRoot, (p) =>
        p.startsWith("/elsewhere/"),
      ),
    ).toBe("/elsewhere");
  });
  test("both main.js and build.json must be there", () => {
    const onlyMain = (p: string) => p === "/repo/packages/infra/image-dist/main.js";
    expect(() => stagingDir({}, repoRoot, onlyMain)).toThrow("holds no staged image");
  });
  test("the placeholder only when asked for by name, and never over a staged image", () => {
    expect(stagingDir({ TABFRAME_IMAGE_PLACEHOLDER: "1" }, repoRoot, nothing)).toBe(
      "/repo/packages/infra/image",
    );
    expect(stagingDir({ TABFRAME_IMAGE_PLACEHOLDER: "1" }, repoRoot, staged)).toBe(
      "/repo/packages/infra/image-dist",
    );
    expect(() => stagingDir({}, repoRoot, nothing)).toThrow(
      "/repo/packages/infra/image-dist holds no staged image",
    );
  });
});

describe("loadAppConfig", () => {
  test("the CI shape: placeholder image, no account, a fixture web directory, no budget", () => {
    expect(
      loadAppConfig(
        {
          TABFRAME_IMAGE_PLACEHOLDER: "1",
          TABFRAME_WEB_DIST: "packages/web/public",
          CDK_DEFAULT_REGION: "us-west-2",
        },
        { repoRoot, exists: nothing },
      ),
    ).toEqual({
      env: { region: "us-west-2" },
      budgetEmail: null,
      stagingDir: "/repo/packages/infra/image",
      fleetDir: "/repo/packages/fleet",
      webDistDir: "packages/web/public",
    });
  });
  test("an operator's deploy: account, address, the staged image, the built bundle", () => {
    expect(
      loadAppConfig(
        {
          CDK_DEFAULT_ACCOUNT: "123456789012",
          CDK_DEFAULT_REGION: "us-west-2",
          TABFRAME_BUDGET_EMAIL: "ops@example.invalid",
        },
        { repoRoot, exists: staged },
      ),
    ).toEqual({
      env: { account: "123456789012", region: "us-west-2" },
      budgetEmail: "ops@example.invalid",
      stagingDir: "/repo/packages/infra/image-dist",
      fleetDir: "/repo/packages/fleet",
      webDistDir: "/repo/packages/web/dist",
    });
  });
  test("the region defaults to us-west-2 and the budget can be declined on purpose", () => {
    const c = loadAppConfig({ TABFRAME_NO_BUDGET: "1" }, { repoRoot, exists: staged });
    expect(c.env).toEqual({ region: "us-west-2" });
    expect(c.budgetEmail).toBeNull();
  });
  test("refuses a synth that would remove the budget, before it looks at the image", () => {
    expect(() => loadAppConfig({}, { repoRoot, exists: nothing })).toThrow(
      "TABFRAME_BUDGET_EMAIL is not set",
    );
  });
});
