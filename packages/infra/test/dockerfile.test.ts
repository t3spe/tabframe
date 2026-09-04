import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The Dockerfile copies exactly what stage-image.ts stages (WP8.2): loop 1 added build.json to the
// staging and forgot the COPY, so /health.build was null in every image.
const STAGED = ["package.json", "main.js", "node-worker.js", "programs/", "build.json"];

describe("image Dockerfile", () => {
  const text = readFileSync(path.join(import.meta.dir, "../image/Dockerfile"), "utf8");
  test("copies every staged file and nothing else", () => {
    const copied = text
      .split("\n")
      .filter((l) => l.startsWith("COPY "))
      .map((l) => l.split(/\s+/)[1] ?? "");
    expect(copied.sort()).toEqual([...STAGED].sort());
  });
  test("pins the base image by digest and the runtime is printed at build time", () => {
    expect(text).toMatch(
      /^FROM public\.ecr\.aws\/lambda\/microvms:al2023-minimal@sha256:[0-9a-f]{64}$/m,
    );
    expect(text).toContain("node --version");
  });
});
