import { describe, expect, test } from "bun:test";
import mise from "../../../mise.toml";

interface Task {
  description?: string;
  run?: string | string[];
  depends?: string[];
  env?: Record<string, unknown>;
}

const tasks = (mise as { tasks: Record<string, Task> }).tasks;
const runLines = (task: Task): string[] =>
  Array.isArray(task.run) ? task.run : task.run ? [task.run] : [];

/** The operator scripts, which need the Tabframe identity; deploy-guard and stage-image do not. */
const AWS_SCRIPT =
  /packages\/(fleet\/scripts|infra\/scripts\/(verify|health|whoami|demo|iam-gate))/;

/**
 * A task touches AWS when a run line uses the AWS CLI, deploys or diffs with the CDK, runs an
 * operator script, or runs a task that does. A synth does not: it runs without credentials on
 * purpose. Depending on the whoami guard is the requirement, not a sign of touching AWS.
 */
function touchesAws(name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const task = tasks[name];
  if (!task) return false;
  for (const line of runLines(task)) {
    if (/^aws\s/.test(line) || /\bcdk (deploy|diff)\b/.test(line) || AWS_SCRIPT.test(line)) {
      return true;
    }
    const sub = /^mise run (\S+)/.exec(line)?.[1];
    if (sub && touchesAws(sub, seen)) return true;
  }
  return (task.depends ?? []).some((d) => d !== "whoami" && touchesAws(d, seen));
}

const awsTasks = Object.keys(tasks).filter((name) => touchesAws(name));

describe("mise.toml", () => {
  test("the AWS-touching tasks are the operator's", () => {
    expect(awsTasks.sort()).toEqual(
      [
        "whoami",
        "deploy",
        "deploy:iam-gate",
        "deploy:stacks",
        "up",
        "down",
        "rotate",
        "rollback",
        "health",
        "logs",
        "logs:fleet",
        "verify",
        "verify:m1",
        "verify:m2",
        "verify:m3",
        "demo",
      ].sort(),
    );
  });

  test("every AWS-touching task carries the profile, the private file, and the whoami guard", () => {
    const offenders: string[] = [];
    for (const name of awsTasks) {
      const task = tasks[name] as Task;
      const env = task.env ?? {};
      const hasEnv =
        env.AWS_PROFILE === "tabframe" &&
        (env._ as { file?: unknown } | undefined)?.file === ".env.local";
      const guarded = name === "whoami" || (task.depends ?? []).includes("whoami");
      if (!hasEnv || !guarded)
        offenders.push(`${name}${hasEnv ? "" : " (no env)"}${guarded ? "" : " (no whoami)"}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no task other than the AWS ones carries the profile or the private file", () => {
    const stray = Object.entries(tasks)
      .filter(([name, task]) => !awsTasks.includes(name) && task.env && "AWS_PROFILE" in task.env)
      .map(([name]) => name);
    expect(stray).toEqual([]);
    const withFile = Object.entries(tasks)
      .filter(([name, task]) => !awsTasks.includes(name) && task.env && "_" in task.env)
      .map(([name]) => name);
    expect(withFile).toEqual([]);
  });

  test("every task says what it does, not which milestone or work package it came from", () => {
    for (const [name, task] of Object.entries(tasks)) {
      expect(task.description, name).toBeTruthy();
      expect(task.description, name).not.toMatch(/^\(?(M\d|WP\d)/);
    }
  });
});
