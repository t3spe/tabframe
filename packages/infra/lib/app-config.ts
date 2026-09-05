// What the CDK app takes from the environment, and the two rules the entry point applies: which
// image directory ships, and whether a missing budget address is a mistake. Pure, so both the app
// and the deploy guard share one definition and the rules are tested without a synth.
import { resolve } from "node:path";
import type * as cdk from "aws-cdk-lib";
import { REGION_DEFAULT } from "../../fleet/src/names.ts";

type Env = Record<string, string | undefined>;

export interface AppConfig {
  env: cdk.Environment;
  /** The budget and alarm address; null means neither is created. */
  budgetEmail: string | null;
  /** The directory zipped as the image's code artifact. */
  stagingDir: string;
  fleetDir: string;
  /** The built web bundle. */
  webDistDir: string;
}

export type BudgetDecision =
  | { kind: "email"; email: string }
  | { kind: "none"; reason: "declined" | "placeholder" }
  | { kind: "missing" };

/**
 * Whether the budget and the alarm mail exist. Without the address they are absent from the
 * templates and a deploy deletes them, so the address must be set or declined on purpose
 * (TABFRAME_NO_BUDGET=1). A synth of the placeholder image (CI) is exempt; a deploy never is.
 */
export function budgetDecision(env: Env, purpose: "synth" | "deploy"): BudgetDecision {
  if (env.TABFRAME_BUDGET_EMAIL) return { kind: "email", email: env.TABFRAME_BUDGET_EMAIL };
  if (env.TABFRAME_NO_BUDGET === "1") return { kind: "none", reason: "declined" };
  if (purpose === "synth" && env.TABFRAME_IMAGE_PLACEHOLDER === "1") {
    return { kind: "none", reason: "placeholder" };
  }
  return { kind: "missing" };
}

/**
 * The staged image when it is there, the placeholder only when asked for by name, otherwise a
 * refusal: a bare `cdk deploy` must not publish the placeholder as the newest version for the next
 * rotation to boot.
 */
export function stagingDir(env: Env, repoRoot: string, exists: (path: string) => boolean): string {
  const dir = env.TABFRAME_IMAGE_DIR ?? resolve(repoRoot, "packages/infra/image-dist");
  if (exists(resolve(dir, "main.js")) && exists(resolve(dir, "build.json"))) return dir;
  if (env.TABFRAME_IMAGE_PLACEHOLDER === "1") return resolve(repoRoot, "packages/infra/image");
  throw new Error(
    `${dir} holds no staged image (main.js and build.json): run \`mise run build\` first, or set TABFRAME_IMAGE_PLACEHOLDER=1 to deploy the placeholder on purpose`,
  );
}

/** The app's configuration from `env`; `exists` is injected so the rules are testable. */
export function loadAppConfig(
  env: Env,
  io: { repoRoot: string; exists: (path: string) => boolean },
): AppConfig {
  const budget = budgetDecision(env, "synth");
  if (budget.kind === "missing") {
    throw new Error(
      "TABFRAME_BUDGET_EMAIL is not set: the budget and the alarm subscription would be removed. Set it in .env.local, or TABFRAME_NO_BUDGET=1 to deploy without them on purpose.",
    );
  }
  const account = env.CDK_DEFAULT_ACCOUNT;
  return {
    env: { region: env.CDK_DEFAULT_REGION ?? REGION_DEFAULT, ...(account ? { account } : {}) },
    budgetEmail: budget.kind === "email" ? budget.email : null,
    stagingDir: stagingDir(env, io.repoRoot, io.exists),
    fleetDir: resolve(io.repoRoot, "packages/fleet"),
    webDistDir: env.TABFRAME_WEB_DIST ?? resolve(io.repoRoot, "packages/web/dist"),
  };
}
