import { describe, expect, test } from "bun:test";
import { maskMicrovmIds, maskSecrets } from "../src/mask.ts";

describe("maskSecrets", () => {
  test("masks a bare 12-digit account id", () => {
    expect(maskSecrets("123456789012")).toBe("********9012");
  });
  test("masks account ids inside ARNs and IAM unique ids", () => {
    expect(maskSecrets("arn:aws:iam::123456789012:user/tab AIDA6CYK2IGRUYFECWJOT")).toBe(
      "arn:aws:iam::********9012:user/tab AIDA****",
    );
  });
  test("redacts proxy tokens in printed JSON", () => {
    expect(maskSecrets('{"endpoint":"x","token":"eyJhbGciOi.abc"}')).toBe(
      '{"endpoint":"x","token":"<redacted>"}',
    );
  });
  test("leaves shorter numbers alone and tolerates undefined", () => {
    expect(maskSecrets("port 8080 and 20260901")).toBe("port 8080 and 20260901");
    expect(maskSecrets(undefined)).toBe("");
  });
});

describe("maskMicrovmIds", () => {
  test("replaces a MicroVM id and leaves other text alone", () => {
    expect(maskMicrovmIds("core microvm-0123abcd-4567-89ef-0123-456789abcdef age 3 s")).toBe(
      "core <microvm-id> age 3 s",
    );
    expect(maskMicrovmIds("mvm-1")).toBe("mvm-1");
  });
});
