// `mise run health`: the active control plane's /health and /diag through the MicroVM proxy on
// the private port, the way the fleet reaches it — a fleet token for port 8081 plus the fleet
// secret from Secrets Manager. Output is masked; nothing here reaches a browser.
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { maskAccount } from "./mask.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
// The secret's ARN is not a stack output; the rotate function carries it in its environment,
// which is exactly what the control plane was handed in its run payload.
const rotateConfig = await new LambdaClient({ region }).send(
  new GetFunctionConfigurationCommand({ FunctionName: "tabframe-rotate" }),
);
const secretArn = rotateConfig.Environment?.Variables?.TABFRAME_FLEET_SECRET_ARN;
const pointerRaw = (
  (await new SSMClient({ region }).send(
    new GetParameterCommand({ Name: "/tabframe/pointer" }),
  )) as {
    Parameter?: { Value?: string };
  }
).Parameter?.Value;
const pointer = JSON.parse(pointerRaw ?? "{}") as {
  state?: string;
  microvmId?: string;
  endpoint?: string;
  generation?: number;
};
if (pointer.state !== "on" || !pointer.microvmId || !pointer.endpoint) {
  console.log(`pointer: ${pointer.state ?? "unset"} — nothing to ask`);
  process.exit(0);
}
const mv = new LambdaMicrovmsClient({ region });
const tok = await mv.send(
  new CreateMicrovmAuthTokenCommand({
    microvmIdentifier: pointer.microvmId,
    expirationInMinutes: 1,
    allowedPorts: [{ port: 8081 }],
  }),
);
const token = tok.authToken?.["X-aws-proxy-auth"] ?? "";
let secret = "";
if (secretArn) {
  const sv = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  secret = sv.SecretString ?? "";
}
const host = pointer.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
const mask = (text: string) => maskAccount(text).replace(/microvm-[0-9a-f-]{36}/g, "<microvm-id>");
let cores: Array<{ microvmId: string; ageMs: number; linked: boolean }> = [];
for (const path of ["/health", "/diag"]) {
  const res = await fetch(`https://${host}${path}`, {
    method: path === "/diag" ? "POST" : "GET",
    headers: {
      "X-aws-proxy-auth": token,
      "X-aws-proxy-port": "8081",
      "x-tabframe-fleet-secret": secret,
    },
  });
  const text = await res.text();
  console.log(`${path} ${res.status} (generation ${pointer.generation ?? "?"})`);
  console.log(mask(text));
  if (path === "/health" && res.ok) {
    try {
      cores = (JSON.parse(text) as { cores?: typeof cores }).cores ?? [];
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
    const t = await mv.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: core.microvmId,
        expirationInMinutes: 1,
        allowedPorts: [{ port: 8081 }],
      }),
    );
    const coreToken = t.authToken?.["X-aws-proxy-auth"] ?? "";
    const g = await mv.send(new GetMicrovmCommand({ microvmIdentifier: core.microvmId }));
    const coreHost = (g.endpoint ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    let line = `state ${g.state}, no endpoint`;
    if (coreHost) {
      try {
        const res = await fetch(`https://${coreHost}/health`, {
          headers: { "X-aws-proxy-auth": coreToken, "X-aws-proxy-port": "8081" },
          signal: AbortSignal.timeout(10_000),
        });
        line = `state ${g.state}, /health ${res.status}: ${mask(await res.text()).slice(0, 400)}`;
      } catch (err) {
        line = `state ${g.state}, /health unreachable: ${String(err).slice(0, 120)}`;
      }
    }
    console.log(
      `core <microvm-id> age ${Math.round(core.ageMs / 1000)} s linked ${core.linked}: ${line}`,
    );
  }
}
