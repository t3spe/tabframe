import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STAGED_FILES } from "../lib/stage-image.ts";

// The Dockerfile copies exactly what stageImage stages: a staged file without a COPY is silently
// absent from every image (build.json once was, and /health.build was null).
describe("image Dockerfile", () => {
  const text = readFileSync(path.join(import.meta.dir, "../image/Dockerfile"), "utf8");
  const copied = text
    .split("\n")
    .filter((l) => l.startsWith("COPY "))
    .map((l) => l.split(/\s+/)[1] ?? "");

  test("copies every staged file and nothing else", () => {
    expect([...copied].sort()).toEqual([...STAGED_FILES].sort());
  });
  test("every COPY source exists in the placeholder directory, which CI synthesises and TABFRAME_IMAGE_PLACEHOLDER=1 deploys", () => {
    for (const name of copied) {
      expect(existsSync(path.join(import.meta.dir, "../image", name.replace(/\/$/, "")))).toBe(
        true,
      );
    }
  });
  test("pins the base image by digest and the runtime is printed at build time", () => {
    expect(text).toMatch(
      /^FROM public\.ecr\.aws\/lambda\/microvms:al2023-minimal@sha256:[0-9a-f]{64}$/m,
    );
    expect(text).toContain("node --version");
  });
});
