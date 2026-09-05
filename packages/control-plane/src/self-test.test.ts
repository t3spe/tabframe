import { describe, expect, test } from "bun:test";
import { selfTest } from "./self-test.ts";

describe("selfTest", () => {
  test("passes against a scratch ledger", () => {
    expect(selfTest()).toBe(true);
  });
});
