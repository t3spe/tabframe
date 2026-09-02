import { describe, expect, test } from "bun:test";
import { configFromEnv } from "./config.ts";

describe("configFromEnv", () => {
  test("local defaults use the 4080/4081 ports and generation 1", () => {
    const c = configFromEnv({});
    expect(c.mode).toBe("local");
    expect(c.publicPort).toBe(4080);
    expect(c.privatePort).toBe(4081);
    expect(c.generation).toBe(1);
    expect(c.storeBase).toBeNull();
    expect(c.webDir).toBeNull();
    expect(c.localOff).toBe(false);
    expect(c.tickMs).toBe(500);
  });
  test("image mode defaults to the MicroVM ports", () => {
    const c = configFromEnv({ TABFRAME_MODE: "image" });
    expect(c.mode).toBe("image");
    expect(c.publicPort).toBe(8080);
    expect(c.privatePort).toBe(8081);
  });
  test("explicit values win and empty strings fall back", () => {
    const c = configFromEnv({
      TABFRAME_PUBLIC_PORT: "0",
      TABFRAME_PRIVATE_PORT: "",
      TABFRAME_GENERATION: "7",
      TABFRAME_STORE_BASE: "https://cdn/blob",
      TABFRAME_WEB_DIR: "/srv/web",
      TABFRAME_LOCAL_OFF: "1",
      TABFRAME_HOST: "0.0.0.0",
      TABFRAME_TICK_MS: "50",
    });
    expect(c.publicPort).toBe(0);
    expect(c.privatePort).toBe(4081);
    expect(c.generation).toBe(7);
    expect(c.storeBase).toBe("https://cdn/blob");
    expect(c.webDir).toBe("/srv/web");
    expect(c.localOff).toBe(true);
    expect(c.host).toBe("0.0.0.0");
    expect(c.tickMs).toBe(50);
  });
  test("bad integers throw", () => {
    expect(() => configFromEnv({ TABFRAME_PUBLIC_PORT: "eighty" })).toThrow(/bad integer/);
    expect(() => configFromEnv({ TABFRAME_GENERATION: "-1" })).toThrow(/bad integer/);
    expect(() => configFromEnv({ TABFRAME_TICK_MS: "1.5" })).toThrow(/bad integer/);
  });
});
