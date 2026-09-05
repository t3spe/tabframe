// `mise run health`: the active control plane's /health and /diag through the MicroVM proxy on the
// private port, the way the fleet reaches it — a fleet token for that port plus the fleet secret.
// Output is masked; nothing here reaches a browser.
import { HttpControlPlaneClient, PRIVATE_PORT } from "../../fleet/src/cp-client.ts";
import { maskMicrovmIds, maskSecrets } from "../../fleet/src/mask.ts";
import { operatorClients, stackResourceId } from "../../fleet/src/operator.ts";
import { normalizeEndpoint } from "../../fleet/src/types.ts";

const { pointer, microvms, secrets } = operatorClients();
const p = await pointer.read();
console.log(
  `pointer: generation ${p.generation}, image version ${p.imageVersion ?? "unknown"}${p.pinnedImageVersion ? ` (pinned to ${p.pinnedImageVersion})` : ""}`,
);
if (p.state !== "on" || !p.microvmId || !p.endpoint) {
  console.log(`pointer: ${p.state} — nothing to ask`);
  process.exit(0);
}
// The secret's ARN is not a stack output; the Core stack's FleetSecret resource names it.
const secret = await secrets.read(await stackResourceId("TabframeCore", "FleetSecret"));
const cp = new HttpControlPlaneClient({ microvms, secret });
const target = { microvmId: p.microvmId, endpoint: normalizeEndpoint(p.endpoint) };
const mask = (text: string) => maskMicrovmIds(maskSecrets(text));
let cores: Array<{ microvmId: string; ageMs: number; linked: boolean }> = [];
for (const path of ["/health", "/diag"]) {
  const { status, body } = await cp.probe(target, path);
  console.log(`${path} ${status} (generation ${p.generation})`);
  console.log(mask(body));
  if (path === "/health" && status >= 200 && status < 300) {
    try {
      cores = (JSON.parse(body) as { cores?: typeof cores }).cores ?? [];
    } catch {
      /* not json */
    }
  }
}

// `--cores`: ask each cloud core's own /health (the core role serves it, open, on the private
// port), which is how an unlinked core — launched, alive, never said hello — is told apart from a
// dead one. Each MicroVM needs a token of its own.
if (process.argv.includes("--cores")) {
  for (const core of cores) {
    const coreToken = await microvms.createAuthToken(core.microvmId, 1, [{ port: PRIVATE_PORT }]);
    const g = await microvms.get(core.microvmId);
    const state = g?.state ?? "not-found";
    let line = `state ${state}, no endpoint`;
    if (g?.endpoint) {
      try {
        const res = await fetch(`https://${g.endpoint}/health`, {
          headers: { "X-aws-proxy-auth": coreToken, "X-aws-proxy-port": String(PRIVATE_PORT) },
          signal: AbortSignal.timeout(10_000),
        });
        line = `state ${state}, /health ${res.status}: ${mask(await res.text()).slice(0, 400)}`;
      } catch (err) {
        line = `state ${state}, /health unreachable: ${String(err).slice(0, 120)}`;
      }
    }
    console.log(
      `core <microvm-id> age ${Math.round(core.ageMs / 1000)} s linked ${core.linked}: ${line}`,
    );
  }
}
