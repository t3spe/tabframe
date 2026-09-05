// Guard: every AWS-touching task depends on this. It refuses to run against anything but the
// dedicated Tabframe account, and never prints an unmasked account id.
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { identityProblem } from "../../fleet/src/identity.ts";
import { maskSecrets } from "../../fleet/src/mask.ts";

function fail(message: string): never {
  console.error(`whoami FAILED: ${message}`);
  process.exit(1);
}

const problem = identityProblem(process.env);
if (problem) fail(problem);

const expected = process.env.TABFRAME_ACCOUNT_ID;
if (!expected || !/^\d{12}$/.test(expected)) fail("TABFRAME_ACCOUNT_ID missing from .env.local");

const identity = await new STSClient({}).send(new GetCallerIdentityCommand({}));
if (identity.Account !== expected) {
  fail(`caller account ${maskSecrets(identity.Account)} is not the Tabframe account`);
}
console.log(
  `whoami ok: account ${maskSecrets(identity.Account)}, ${maskSecrets(identity.Arn)}, region ${process.env.AWS_REGION}`,
);
