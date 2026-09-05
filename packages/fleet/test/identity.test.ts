import { describe, expect, test } from "bun:test";
import { assertTabframeIdentity, identityProblem } from "../src/identity.ts";

describe("identityProblem", () => {
  test("the Tabframe profile in us-west-2 passes", () => {
    expect(identityProblem({ AWS_PROFILE: "tabframe", AWS_REGION: "us-west-2" })).toBeNull();
  });
  test("another or no profile is named first", () => {
    expect(identityProblem({ AWS_PROFILE: "default", AWS_REGION: "us-west-2" })).toBe(
      'AWS_PROFILE is default, expected "tabframe"',
    );
    expect(identityProblem({})).toBe('AWS_PROFILE is unset, expected "tabframe"');
  });
  test("the wrong or no region is named", () => {
    expect(identityProblem({ AWS_PROFILE: "tabframe", AWS_REGION: "eu-west-1" })).toBe(
      "AWS_REGION is eu-west-1, expected us-west-2",
    );
    expect(identityProblem({ AWS_PROFILE: "tabframe" })).toBe(
      "AWS_REGION is unset, expected us-west-2",
    );
  });
});

describe("assertTabframeIdentity", () => {
  test("throws with the problem, and passes silently otherwise", () => {
    expect(() => assertTabframeIdentity({ AWS_PROFILE: "prod" })).toThrow("AWS_PROFILE is prod");
    expect(() =>
      assertTabframeIdentity({ AWS_PROFILE: "tabframe", AWS_REGION: "us-west-2" }),
    ).not.toThrow();
  });
});
