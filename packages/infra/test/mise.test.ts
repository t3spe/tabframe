import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Every task that talks to AWS carries the Tabframe identity and the account guard (WP8.3): loop 2
// scoped the environment to "the ten AWS tasks" and missed four; the rule is now checked.
const toml = readFileSync(path.join(import.meta.dir, "../../../mise.toml"), "utf8");
const tasks = new Map<string, string>();
for (const m of toml.matchAll(/\n\[tasks\.("?)([^\]"]+)\1\]\n([\s\S]*?)(?=\n\[|$)/g))
  tasks.set(m[2] ?? "", m[3] ?? "");

const touchesAws = (body: string): boolean =>
  /\baws\s|\bcdk\s|packages\/fleet\/scripts\/|packages\/infra\/scripts\/(verify|health|whoami|demo)/.test(
    body,
  );

describe("mise.toml", () => {
  test("every AWS-touching task carries the profile, the private file, and the whoami guard", () => {
    const offenders: string[] = [];
    for (const [name, body] of tasks) {
      if (!touchesAws(body)) continue;
      const hasEnv = /env = \{[^}]*AWS_PROFILE = "tabframe"[^}]*_\.file = "\.env\.local"/.test(
        body,
      );
      const guarded = name === "whoami" || /depends = \[[^\]]*"whoami"/.test(body);
      if (!hasEnv || !guarded)
        offenders.push(`${name}${hasEnv ? "" : " (no env)"}${guarded ? "" : " (no whoami)"}`);
    }
    expect(offenders).toEqual([]);
  });
  test("no task other than the AWS ones carries the profile", () => {
    const stray = [...tasks]
      .filter(([, body]) => !touchesAws(body) && /AWS_PROFILE/.test(body))
      .map(([n]) => n);
    expect(stray).toEqual([]);
  });
});
