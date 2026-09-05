// CDK app entry, run by the repo-root cdk.json (`node packages/infra/bin/tabframe.ts`).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "../lib/app.ts";
import { loadAppConfig } from "../lib/app-config.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
buildApp(loadAppConfig(process.env, { repoRoot, exists: existsSync })).app.synth();
