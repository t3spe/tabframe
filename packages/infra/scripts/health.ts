// `mise run health`: the active control plane's /health and /diag through the MicroVM proxy on
// the private port, the way the fleet reaches it — a fleet token for port 8081 plus the fleet
// secret from Secrets Manager. Output is masked; nothing here reaches a browser.
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateMicrovmAuthTokenCommand,
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
  console.log(maskAccount(text).replace(/microvm-[0-9a-f-]{36}/g, "<microvm-id>"));
}
