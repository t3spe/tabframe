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
    expect(c.tickMs).toBe(500);
    if (c.mode !== "local") throw new Error("expected local mode");
    expect(c.localOff).toBe(false);
    expect(c.localNeutral).toBe(false);
  });
  test("image mode defaults to the MicroVM ports and carries the buckets and the pointer", () => {
    const c = configFromEnv({ TABFRAME_MODE: "image" });
    expect(c.mode).toBe("image");
    expect(c.publicPort).toBe(8080);
    expect(c.privatePort).toBe(8081);
    if (c.mode !== "image") throw new Error("expected image mode");
    expect(c.blobBucket).toBeNull();
    expect(c.snapshotBucket).toBeNull();
    expect(c.pointerParam).toBeNull();
    expect(c.cores).toBeNull();
  });
  test("cores need both the image and the core role", () => {
    const withoutRole = configFromEnv({ TABFRAME_MODE: "image", TABFRAME_IMAGE_ARN: "arn:image" });
    if (withoutRole.mode !== "image") throw new Error("expected image mode");
    expect(withoutRole.cores).toBeNull();
    const c = configFromEnv({
      TABFRAME_MODE: "image",
      TABFRAME_IMAGE_ARN: "arn:image",
      TABFRAME_CORE_ROLE_ARN: "arn:role",
      TABFRAME_IMAGE_VERSION: "7",
      TABFRAME_BLOB_BUCKET: "blobs",
      TABFRAME_POINTER_PARAM: "/tabframe/pointer",
    });
    if (c.mode !== "image") throw new Error("expected image mode");
    expect(c.cores).toEqual({ imageArn: "arn:image", imageVersion: "7", coreRoleArn: "arn:role" });
    expect(c.blobBucket).toBe("blobs");
    expect(c.pointerParam).toBe("/tabframe/pointer");
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
      TABFRAME_PROGRAMS_DIR: "",
    });
    expect(c.publicPort).toBe(0);
    expect(c.privatePort).toBe(4081);
    expect(c.generation).toBe(7);
    expect(c.storeBase).toBe("https://cdn/blob");
    expect(c.webDir).toBe("/srv/web");
    expect(c.host).toBe("0.0.0.0");
    expect(c.tickMs).toBe(50);
    expect(c.programsDir).toBeNull();
    if (c.mode !== "local") throw new Error("expected local mode");
    expect(c.localOff).toBe(true);
  });
  test("bad integers throw", () => {
    expect(() => configFromEnv({ TABFRAME_PUBLIC_PORT: "eighty" })).toThrow(/bad integer/);
    expect(() => configFromEnv({ TABFRAME_GENERATION: "-1" })).toThrow(/bad integer/);
    expect(() => configFromEnv({ TABFRAME_TICK_MS: "1.5" })).toThrow(/bad integer/);
  });
});
