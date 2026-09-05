import { describe, expect, test } from "bun:test";
import { LOCAL_PAGE_CSP, PAGE_CSP, pageCsp } from "./headers.ts";

// The policies the deployed distribution and the local server send, pinned as strings: a change
// here is a change to what every browser enforces on the page.
const TAIL =
  "script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'";
const REMOTE =
  "https://*.lambda-url.us-west-2.on.aws wss://*.lambda-microvm.us-west-2.on.aws https://*.s3.us-west-2.amazonaws.com";
const DEPLOYED = `default-src 'self'; connect-src 'self' data: blob: ${REMOTE}; ${TAIL}`;
const LOCAL = `default-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* data: blob: ${REMOTE}; ${TAIL}`;

describe("pageCsp", () => {
  test("the deployed and the local policies are exactly what they were", () => {
    expect(PAGE_CSP).toBe(DEPLOYED);
    expect(LOCAL_PAGE_CSP).toBe(LOCAL);
    expect(pageCsp("us-west-2")).toBe(PAGE_CSP);
    expect(pageCsp("us-west-2", { local: true })).toBe(LOCAL_PAGE_CSP);
  });
  test("the region names the function URL, the MicroVM endpoints, and the bucket; the loopback only locally", () => {
    const eu = pageCsp("eu-west-1");
    expect(eu).toContain(
      "connect-src 'self' data: blob: https://*.lambda-url.eu-west-1.on.aws wss://*.lambda-microvm.eu-west-1.on.aws https://*.s3.eu-west-1.amazonaws.com;",
    );
    expect(eu).not.toContain("127.0.0.1");
    expect(pageCsp("eu-west-1", { local: true })).toContain(
      "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* data: blob: https://*.lambda-url.eu-west-1.on.aws",
    );
  });
});
