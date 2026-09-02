import { describe, expect, test } from "bun:test";
import { byteLength, canonicalStringify } from "./canonical.ts";

describe("canonicalStringify", () => {
  test("sorts keys recursively and drops undefined", () => {
    expect(canonicalStringify({ z: 1, a: { y: undefined, b: [3, { k: 1, j: 2 }] } })).toBe(
      '{"a":{"b":[3,{"j":2,"k":1}]},"z":1}',
    );
  });
  test("preserves array order and scalars", () => {
    expect(canonicalStringify([3, 1, "b", null, true])).toBe('[3,1,"b",null,true]');
    expect(canonicalStringify("s")).toBe('"s"');
  });
  test("is stable regardless of insertion order", () => {
    const a = canonicalStringify({ x: 1, y: { p: 1, q: 2 } });
    const b = canonicalStringify({ y: { q: 2, p: 1 }, x: 1 });
    expect(a).toBe(b);
  });
});

describe("byteLength", () => {
  test("counts UTF-8 bytes, not code units", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("🐋")).toBe(4);
  });
});
