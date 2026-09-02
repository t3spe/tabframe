import { describe, expect, test } from "bun:test";
import { maskAccount } from "./mask.ts";

describe("maskAccount", () => {
  test("masks a bare 12-digit account id", () => {
    expect(maskAccount("123456789012")).toBe("********9012");
  });
  test("masks account ids inside ARNs and IAM unique ids", () => {
    expect(maskAccount("arn:aws:iam::123456789012:user/tab AIDA6CYK2IGRUYFECWJOT")).toBe(
      "arn:aws:iam::********9012:user/tab AIDA****",
    );
  });
  test("leaves shorter numbers alone and tolerates undefined", () => {
    expect(maskAccount("port 8080 and 20260901")).toBe("port 8080 and 20260901");
    expect(maskAccount(undefined)).toBe("");
  });
});
