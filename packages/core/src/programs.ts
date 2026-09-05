// The program list (design §5.1, §5.6): the bundles the ledger knows, and retired ones kept only
// while an execution still refers to them.
import type { FsManifest, ProgramManifest } from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import type { Ledger } from "./ledger.ts";
import { broadcast } from "./observers.ts";
import { PROGRAMS_CAP } from "./policy.ts";

export function addProgram(
  ledger: Ledger,
  bundle: string,
  module: string,
  manifest: ProgramManifest,
  files: FsManifest["files"],
  now: number,
): Effect[] {
  ledger.programs.set(bundle, { bundle, module, manifest, files, addedAt: now });
  const effects = broadcast(ledger, { t: "programAdded", program: bundle, name: manifest.name });
  // Every program rides page 0 of every snapshot: past the cap the oldest ones nobody runs, refers
  // to, or loops on are retired.
  const live = [...ledger.programs.values()].filter((p) => !p.retired);
  if (live.length > PROGRAMS_CAP) {
    const referenced = new Set([...ledger.executions.values()].map((e) => e.bundle));
    if (ledger.config.defaultLoop) referenced.add(ledger.config.defaultLoop.bundle);
    const spare = live
      .filter((p) => p.bundle !== bundle && !referenced.has(p.bundle))
      .sort((a, b) => a.addedAt - b.addedAt);
    for (const p of spare.slice(0, live.length - PROGRAMS_CAP))
      effects.push(...retireProgram(ledger, p.bundle));
  }
  return effects;
}

/**
 * A newer bundle ships under this program's name: the record is hidden and refuses launches, so
 * the follow-up chain of the old frame ends, and it is dropped once no execution refers to it —
 * `fill` and inheritance still need the module and files of one that does.
 */
export function retireProgram(ledger: Ledger, bundle: string): Effect[] {
  const program = ledger.programs.get(bundle);
  if (!program || program.retired) return [];
  program.retired = true;
  const effects = broadcast(ledger, {
    t: "programRetired",
    program: bundle,
    name: program.manifest.name,
  });
  dropUnreferencedRetired(ledger);
  return effects;
}

/** Retired programs that no execution refers to any more are dropped. */
export function dropUnreferencedRetired(ledger: Ledger): void {
  for (const program of ledger.programs.values()) {
    if (!program.retired) continue;
    let referenced = false;
    for (const e of ledger.executions.values()) {
      if (e.bundle === program.bundle) {
        referenced = true;
        break;
      }
    }
    if (!referenced) ledger.programs.delete(program.bundle);
  }
}
